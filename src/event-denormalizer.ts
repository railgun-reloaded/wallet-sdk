import type { DBNewCommitment, DBNewNullifier, DBNewUnshield } from '@railgun-reloaded/storage'
import type { EVMBlock, EncryptedCommitment, GeneratedCommitment, Shield, ShieldCommitment, Transact, TransactCommitment, Unshield } from 'scanner'
import { ActionType } from 'scanner'

enum CommitmentType {
  Shield = 0,
  Transact = 1,
}

/**
 * Left pads byte array to length
 * @param byteArray - byte array to pad
 * @param length - length of new array
 * @returns padded array
 */
const arrayToByteLength = (byteArray: Uint8Array, length: number): Uint8Array => {
  // Check the length of array requested is large enough to accommodate the original array
  if (byteArray.length > length) { throw new Error('BigInt byte size is larger than length') }

  // Create Uint8Array of requested length
  return new Uint8Array(
    new Array(length - byteArray.length).concat(...byteArray)
  )
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
            hash: arrayToByteLength(hash, 32),
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
            hash: arrayToByteLength(hash, 32),
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
            hash: arrayToByteLength(c.hash, 32),
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
            hash: arrayToByteLength(c.hash, 32),
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
