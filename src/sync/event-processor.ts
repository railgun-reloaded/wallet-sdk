import { padBytesLeft } from '@railgun-reloaded/bytes'
import type { EVMBlock, EncryptedCommitment, GeneratedCommitment, Shield, ShieldCommitment, Transact, TransactCommitment, Unshield } from '@railgun-reloaded/scanner'
import { ActionType } from '@railgun-reloaded/scanner'
import type { DBNewCommitment, DBNewNullifier, DBNewUnshield } from '@railgun-reloaded/storage'

enum CommitmentType {
  Shield = 0,
  Transact = 1,
}

/**
 * Left-pad a commitment hash while rejecting over-length values.
 * @param hash - Commitment hash bytes.
 * @returns Exactly 32 bytes.
 */
function padCommitmentHash (hash: Uint8Array): Uint8Array {
  if (hash.length > 32) {
    throw new Error(`Commitment hash exceeds 32 bytes: ${hash.length}`)
  }
  return padBytesLeft(hash, 32)
}

/**
 * Denormalize blockData into nullifiers and commitments
 * @param block - Input BlockData
 * @returns - Denormalized nullifiers and commitments
 */
function denormalizeBlockData (block : EVMBlock) : {
  nullifiers: DBNewNullifier[],
  commitments: DBNewCommitment[],
  unshields: DBNewUnshield[]
} {
  const nullifiers = new Array<DBNewNullifier>()
  const commitments = new Array<DBNewCommitment>()
  const unshields = new Array<DBNewUnshield>()

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
            hash: padCommitmentHash(hash),
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
            hash: padCommitmentHash(hash),
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
          /**
           * Both encryptedCommitment/TransactCommitment has additional field txID and boundParamHash
           * which is required for PPOI. This is not handled currently.
           */
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
            hash: padCommitmentHash(c.hash),
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
            hash: padCommitmentHash(c.hash),
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

  return { nullifiers, commitments, unshields }
}

export { denormalizeBlockData, CommitmentType }
