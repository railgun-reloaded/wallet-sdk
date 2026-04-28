import { bigIntToBytes, bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import { poseidon } from '@railgun-reloaded/cryptography'
import type { Shield, Transact } from '@railgun-reloaded/scanner'
import type { TokenData, TokenDataGetter } from '@railgun-reloaded/wallet-node'
import {
  ChainType,
  RailgunWallet,
  ShieldNote,
  TokenType,
  TXIDVersion,
  decryptCommitmentAsReceiverOrSender,
} from '@railgun-reloaded/wallet-node'

enum NoteType {
  Shield = 'shield',
  TransactReceived = 'transact-received',
  TransactSent = 'transact-sent'
}

type DecryptedNote = {
  commitment: string
  nullifier: string
  token: string
  amount: bigint
  blockNumber: bigint
  treeNumber: number
  leafIndex: bigint
  noteType: NoteType
}

/**
 * Token balance aggregated from notes
 */
type TokenBalance = {
  token: string
  balance: bigint
  notes: DecryptedNote[]
}

/**
 * Simple token data getter for ERC20 tokens
 * Extracts token address from the last 20 bytes of the hash
 */
const createTokenDataGetter = (): TokenDataGetter => ({
  async getTokenDataFromHash (_txidVersion: any, _chain: any, tokenHash: string): Promise<TokenData> {
    const cleanHash = tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash
    const addressHex = cleanHash.slice(24) // last 20 bytes = address
    return {
      tokenType: TokenType.ERC20,
      tokenAddress: hexToBytes(`0x${addressHex}`),
      tokenSubID: new Uint8Array(32)
    }
  }
})

/**
 * RAILGUN Wallet SDK
 *
 * Provides a clean, viem-like API for RAILGUN privacy protocol operations.
 * Manages wallet creation, note scanning, balance tracking, and future transaction building.
 *
 * @example
 * ```typescript
 * import { RailgunWalletSDK } from '@railgun-reloaded/wallet-sdk'
 * import { SubsquidProvider } from '@railgun-reloaded/scanner'
 * import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
 *
 * // Initialize crypto (once per app)
 * await initializeCryptographyLibs()
 *
 * // Create wallet
 * const wallet = new RailgunWalletSDK(
 *   'test test test test test test test test test test test junk',
 *   11155111 // Sepolia
 * )
 *
 * // Connect to data source
 * const provider = new SubsquidProvider('https://...')
 *
 * // Scan for notes
 * await wallet.scan(provider, { startBlock: 5944761n })
 *
 * // Get balances
 * const balances = wallet.getBalances()
 * console.log(balances)
 *
 * provider.destroy()
 * ```
 */
export class RailgunWalletSDK {
  private wallet: RailgunWallet
  private chain: { type: ChainType; id: number }
  private notes: DecryptedNote[] = []
  private spentNullifiers = new Set<string>()

  /**
   * Create a new RAILGUN wallet instance
   * @param mnemonic - BIP39 mnemonic phrase
   * @param chainId - EVM chain ID (e.g., 1 for Ethereum mainnet, 11155111 for Sepolia)
   * @param derivationIndex - BIP44 derivation index (default: 0)
   */
  constructor (mnemonic: string, chainId: number = 11155111, derivationIndex: number = 0) {
    this.wallet = new RailgunWallet(mnemonic, derivationIndex)
    this.chain = { type: ChainType.EVM, id: chainId }
  }

  /**
   * Get the RAILGUN address (master public key in hex format)
   * This is the public identifier for receiving private transfers
   */
  getAddress (): string {
    return bytesToHex(this.wallet.getMasterPublicKey(), { prefix: true })
  }

  /**
   * Get the viewing public key in hex format
   * Used for establishing shared secrets in ECDH encryption
   */
  getViewingPublicKey (): string {
    return bytesToHex(this.wallet.getViewingPublicKey(), { prefix: true })
  }

  /**
   * Get the spending public key
   * Used in commitment generation
   */
  getSpendingPublicKey (): string {
    const spk = this.wallet.getSpendingPublicKey()
    return `${bytesToHex(spk[0], { prefix: true })},${bytesToHex(spk[1], { prefix: true })}`
  }

  /**
   * Scan blockchain for notes belonging to this wallet
   *
   * Processes all Shield and Transact actions, attempting to decrypt
   * notes and tracking spent nullifiers for balance calculation.
   *
   * @param provider - Data source (Subsquid, RPC, or aggregator)
   * @param options - Scan options
   * @param options.startBlock - Starting block number (required)
   * @param options.endBlock - Ending block number (optional, scans to latest if omitted)
   * @param options.onProgress - Progress callback (optional)
   */
  async scan (
    provider: any, // SubsquidProvider or SourceAggregator
    options: {
      startBlock: bigint
      endBlock?: bigint
      onProgress?: (blockNumber: bigint, notesFound: number) => void
    }
  ): Promise<void> {
    const fromOptions: any = {
      startHeight: options.startBlock,
      chunkSize: 100n
    }
    if (options.endBlock !== undefined) {
      fromOptions.endHeight = options.endBlock
    }
    const iterator = provider.from(fromOptions)

    let blockCount = 0

    for await (const block of iterator) {
      blockCount++

      for (const tx of block.transactions) {
        for (const actionGroup of tx.actions) {
          for (const action of actionGroup) {
            if (action.actionType === 'ShieldCommitment' || action.actionType === 'GeneratedCommitment') {
              await this.processShield(action as Shield, block.number)
            } else if (action.actionType === 'TransactCommitment' || action.actionType === 'EncryptedCommitment') {
              await this.processTransact(action as Transact, block.number)
            }
          }
        }
      }

      if (options.onProgress && blockCount % 100 === 0) {
        options.onProgress(block.number, this.notes.length)
      }
    }
  }

  /**
   * Process a shield action - decrypt notes from public→private shields
   */
  private async processShield (action: Shield, blockNumber: bigint): Promise<void> {
    const viewingPrivateKey = this.wallet.getViewingPrivateKey()
    const masterPublicKeyBytes = this.wallet.getMasterPublicKey()
    const nullifyingKey = this.wallet.getNullifyingKey()
    const commitment = action.commitment

    let shieldNote: ShieldNote | null

    if ('encryptedRandom' in commitment) {
      // V1: GeneratedCommitment with plaintext random
      shieldNote = ShieldNote.fromGeneratedCommitment(commitment, viewingPrivateKey, masterPublicKeyBytes)
    } else {
      // V2+: ShieldCommitment with ECDH-encrypted bundle
      shieldNote = await ShieldNote.fromShieldCommitment(commitment, viewingPrivateKey, masterPublicKeyBytes)
    }

    if (!shieldNote) {
      return
    }

    const leafIndexBytes = bigIntToBytes(BigInt(commitment.treePosition), 32)
    const nullifier = poseidon([nullifyingKey, leafIndexBytes])

    this.notes.push({
      commitment: bytesToHex(commitment.hash, { prefix: true }),
      nullifier: bytesToHex(nullifier, { prefix: true }),
      token: bytesToHex(shieldNote.tokenData.tokenAddress, { prefix: true }),
      amount: shieldNote.value,
      blockNumber,
      treeNumber: commitment.treeNumber,
      leafIndex: BigInt(commitment.treePosition),
      noteType: NoteType.Shield
    })
  }

  /**
   * Process a transact action - decrypt notes from private→private transfers
   */
  private async processTransact (action: Transact, blockNumber: bigint): Promise<void> {
    const viewingPrivateKey = this.wallet.getViewingPrivateKey()
    const nullifyingKey = this.wallet.getNullifyingKey()
    const tokenDataGetter = createTokenDataGetter()

    // Track spent nullifiers from this transaction
    for (const nullifier of action.nullifiers) {
      this.spentNullifiers.add(bytesToHex(nullifier, { prefix: true }))
    }

    for (const commitment of action.commitments) {
      if (!('blindedSenderViewingKey' in commitment)) {
        continue // Not a transact commitment
      }

      const result = await decryptCommitmentAsReceiverOrSender(
        TXIDVersion.V2_PoseidonMerkle,
        this.chain,
        commitment.ciphertext,
        commitment.blindedReceiverViewingKey,
        commitment.blindedSenderViewingKey,
        viewingPrivateKey,
        tokenDataGetter
      )

      const { receiverData, senderData } = result
      const decrypted = receiverData ?? senderData

      if (!decrypted) {
        continue // Not for this wallet
      }

      const isReceiver = receiverData !== null

      const leafIndexBytes = bigIntToBytes(BigInt(commitment.treePosition), 32)
      const nullifier = poseidon([nullifyingKey, leafIndexBytes])

      this.notes.push({
        commitment: bytesToHex(commitment.hash, { prefix: true }),
        nullifier: bytesToHex(nullifier, { prefix: true }),
        token: bytesToHex(decrypted.tokenData.tokenAddress, { prefix: true }),
        amount: decrypted.value,
        blockNumber,
        treeNumber: commitment.treeNumber,
        leafIndex: BigInt(commitment.treePosition),
        noteType: isReceiver ? NoteType.TransactReceived : NoteType.TransactSent
      })
    }
  }

  /**
   * Get all notes (spent and unspent)
   */
  getNotes (): DecryptedNote[] {
    return [...this.notes]
  }

  /**
   * Get unspent notes only
   * These are notes whose nullifiers have not been seen on-chain
   */
  getUnspentNotes (): DecryptedNote[] {
    return this.notes.filter(note => !this.spentNullifiers.has(note.nullifier))
  }

  /**
   * Get token balances aggregated from unspent notes
   *
   * @returns Array of token balances with underlying notes
   */
  getBalances(): TokenBalance[] {
    const unspentNotes = this.getUnspentNotes()
    if (unspentNotes.length === 0) {
      return []
    }

    const balanceMap = new Map<string, { balance: bigint; notes: DecryptedNote[] }>()

    for (const note of unspentNotes) {
      const existing = balanceMap.get(note.token)
      if (existing) {
        existing.balance += note.amount
        existing.notes.push(note)
      } else {
        balanceMap.set(note.token, { balance: note.amount, notes: [note] })
      }
    }
    return Array.from(balanceMap.entries()).map(([token, { balance, notes }]) => ({
      token,
      balance,
      notes
    }))
  }

  /**
   * Get balance for a specific token
   *
   * @param tokenAddress - ERC20 token address (case-insensitive)
   * @returns Total unspent balance for the token
   */
  getTokenBalance (tokenAddress: string): bigint {
    const normalizedToken = tokenAddress.toLowerCase()
    const unspentNotes = this.getUnspentNotes()
    return unspentNotes
      .filter(note => note.token.toLowerCase() === normalizedToken)
      .reduce((sum, note) => sum + note.amount, 0n)
  }

  /**
   * Get statistics about the wallet's note set
   */
  getStats () {
    return {
      totalNotes: this.notes.length,
      unspentNotes: this.getUnspentNotes().length,
      spentNullifiers: this.spentNullifiers.size,
      uniqueTokens: new Set(this.notes.map(n => n.token)).size
    }
  }
}

export { NoteType }
export type { DecryptedNote, TokenBalance }
