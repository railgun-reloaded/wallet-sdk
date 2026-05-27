import { CHAIN_ID_ANY, ChainType, stringify } from '@railgun-reloaded/0zk-addresses'
import { RailgunWallet } from '@railgun-reloaded/wallet-node'

import { generateWalletId } from './wallet-id'

/**
 * The full set of RAILGUN key material derivable from a mnemonic, plus the
 * deterministic wallet ID and 0zk address. Does not include the spending key
 * — that stays encrypted at rest and is re-derived on demand by signing APIs.
 */
type WalletKeys = {
  walletId: string
  railgunAddress: string
  masterPublicKey: Uint8Array
  viewingPublicKey: Uint8Array
  viewingPrivateKey: Uint8Array
  nullifyingKey: Uint8Array
}

/**
 * Derive RAILGUN key material from a mnemonic without any persistence.
 *
 * Returns the same keys loadWallet exposes (minus the stored wallet name).
 * This is the shared code path between loadWallet and scripts / REPL
 * consumers that don't need a DB — intentionally exported as a free function.
 *
 * Precondition: the cryptography libraries must be initialized before calling.
 * `RailgunClient` callers get this for free — it auto-initializes on
 * `createWallet`/`loadWallet`. Direct callers (scripts, REPL) must `await`
 * `initializeCrypto()` (from `@railgun-reloaded/wallet-sdk`) first.
 *
 * Implementation note: the underlying wallet-node RailgunWallet eagerly
 * derives the spending keypair and holds it in memory for the object's
 * lifetime. This function does not retain that object beyond the call, but
 * it also makes no effort to wipe memory — "encrypted at rest" refers to
 * on-disk storage only, not in-process secrets during active use.
 * @param mnemonic - BIP39 mnemonic phrase.
 * @param index - BIP44-style derivation index (default 0).
 * @returns The derived key material plus walletId and 0zk address.
 */
function deriveWalletKeys (mnemonic: string, index: number = 0): WalletKeys {
  const railgunWallet = new RailgunWallet(mnemonic, index)

  const masterPublicKey = railgunWallet.getMasterPublicKey()
  const viewingPublicKey = railgunWallet.getViewingPublicKey()
  const viewingPrivateKey = railgunWallet.getViewingPrivateKey()
  const nullifyingKey = railgunWallet.getNullifyingKey()

  const walletId = generateWalletId(mnemonic, index)
  const railgunAddress = stringify({
    version: 1,
    masterPublicKey,
    viewingPublicKey,
    chain: { type: ChainType.ANY, id: CHAIN_ID_ANY }
  })

  return {
    walletId,
    railgunAddress,
    masterPublicKey,
    viewingPublicKey,
    viewingPrivateKey,
    nullifyingKey
  }
}

export { deriveWalletKeys }
export type { WalletKeys }
