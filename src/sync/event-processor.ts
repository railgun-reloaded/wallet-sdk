import { padBytesLeft } from '@railgun-reloaded/bytes'
import type {
  EVMBlock,
  EncryptedCommitment,
  GeneratedCommitment,
  ScannedRailgunTransaction,
  Shield,
  ShieldCommitment,
  Transact,
  TransactCommitment,
  Unshield
} from '@railgun-reloaded/scanner'
import { ActionType, extractRailgunTransactions } from '@railgun-reloaded/scanner'
import type { DBNewCommitment, DBNewNullifier, DBNewRailgunTransaction, DBNewUnshield } from '@railgun-reloaded/storage'

/**
 * Map a scanner Railgun-tx DTO onto the storage row shape. graphID and
 * verificationHash are not modeled by scanner; we persist them as null.
 * @param dto - Scanner Railgun-tx DTO.
 * @returns Storage row for chain.db.
 */
function toDBRow (dto: ScannedRailgunTransaction): DBNewRailgunTransaction {
  return {
    railgunTxid: dto.railgunTxid,
    txidVersion: dto.txidVersion,
    chainTxid: dto.chainTxid,
    graphID: null,
    blockNumber: dto.blockNumber,
    timestamp: dto.timestamp,
    nullifiers: dto.nullifiers,
    commitments: dto.commitments,
    boundParamsHash: dto.boundParamsHash,
    hasUnshield: dto.hasUnshield,
    unshield: dto.unshield,
    utxoTreeIn: dto.utxoTreeIn,
    utxoTreeOut: dto.utxoTreeOut,
    utxoBatchStartPositionOut: dto.utxoBatchStartPositionOut,
    verificationHash: null,
  }
}

enum CommitmentType {
  Shield = 0,
  Transact = 1,
}

/**
 * Denormalize blockData into nullifiers and commitments
 * @param block - Input BlockData
 * @returns - Denormalized nullifiers and commitments
 */
function denormalizeBlockData (block : EVMBlock) : {
  nullifiers: DBNewNullifier[],
  commitments: DBNewCommitment[],
  unshields: DBNewUnshield[],
  railgunTransactions: DBNewRailgunTransaction[]
} {
  const nullifiers = new Array<DBNewNullifier>()
  const commitments = new Array<DBNewCommitment>()
  const unshields = new Array<DBNewUnshield>()
  const railgunTransactions = extractRailgunTransactions(block).map(toDBRow)

  const blockNumber = block.number
  for (const tx of block.transactions) {
    const transactionHash = tx.hash
    const actions = tx.actions.flat()
    for (const action of actions) {
      switch (action.actionType) {
        case ActionType.ShieldCommitment:
        {
          const shield = action as Shield
          const { treeNumber, treePosition, hash, preimage, encryptedBundle, shieldKey, fee } = shield.commitment as ShieldCommitment
          commitments.push({
            transactionHash,
            blockNumber,
            treeNumber,
            treePosition,
            hash: padBytesLeft(hash, 32, { strict: true }),
            commitmentType: CommitmentType.Shield,
            commitment: {
              preimage,
              encryptedBundle,
              shieldKey,
              fee
            }
          })
          break
        }
        case ActionType.GeneratedCommitment:
        {
          const shield = action as Shield
          const { treeNumber, treePosition, hash, preimage, encryptedRandom, } = shield.commitment as GeneratedCommitment
          commitments.push({
            transactionHash,
            blockNumber,
            treeNumber,
            treePosition,
            hash: padBytesLeft(hash, 32, { strict: true }),
            commitmentType: CommitmentType.Shield,
            commitment: {
              preimage,
              encryptedRandom,
            }
          })
          break
        }
        case ActionType.EncryptedCommitment:
        {
          const transact = action as Transact
          nullifiers.push(...transact.nullifiers.map(nullifier => ({
            nullifier,
            transactionHash,
            blockNumber,
            treeNumber: transact.utxoTreeIn
          })))

          const transactCommitments = transact.commitments as EncryptedCommitment[]
          commitments.push(...transactCommitments.map((c) => ({
            transactionHash,
            blockNumber,
            treeNumber: c.treeNumber,
            hash: padBytesLeft(c.hash, 32, { strict: true }),
            treePosition: c.treePosition,
            commitmentType: CommitmentType.Transact,
            commitment: {
              ciphertext: c.ciphertext,
              ephemeralKeys: c.ephemeralKeys,
              memo: c.memo
            },
          })))
          break
        }
        case ActionType.TransactCommitment:
        {
          const transact = action as Transact
          nullifiers.push(...transact.nullifiers.map(nullifier => ({
            nullifier,
            transactionHash,
            blockNumber,
            treeNumber: transact.utxoTreeIn
          })))

          const transactCommitments = transact.commitments as TransactCommitment[]
          commitments.push(...transactCommitments.map((c) => ({
            transactionHash,
            blockNumber,
            treeNumber: c.treeNumber,
            hash: padBytesLeft(c.hash, 32, { strict: true }),
            treePosition: c.treePosition,
            commitmentType: CommitmentType.Transact,
            commitment: {
              ciphertext: c.ciphertext,
              blindedSenderViewingKey: c.blindedSenderViewingKey,
              blindedReceiverViewingKey: c.blindedReceiverViewingKey,
              annotationData: c.annotationData,
              memo: c.memo,
            },
          })))
          break
        }
        case ActionType.Unshield: {
          const unshield = action as Unshield
          unshields.push({
            transactionHash,
            blockNumber,
            timestamp: block.timestamp,
            toAddress: unshield.to,
            amount: unshield.amount,
            fee: unshield.fee,
            eventLogIndex: unshield.eventLogIndex
          })
        }
      }
    }
  }

  return { nullifiers, commitments, unshields, railgunTransactions }
}

export { denormalizeBlockData, CommitmentType }
