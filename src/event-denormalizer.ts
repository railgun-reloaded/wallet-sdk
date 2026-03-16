import type { DBNewCommitment, DBNewNullifier } from '@railgun-reloaded/storage'
import type { EVMBlock, Shield, Transact } from 'scanner'
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
  nullifiers: DBNewNullifier[]
  commitments: DBNewCommitment[]
} {
  const nullifiers = new Array<DBNewNullifier>()
  const commitments = new Array<DBNewCommitment>()

  const blockNumber = block.number
  for (const tx of block.transactions) {
    const transactionHash = tx.hash
    const actions = tx.actions.flat()
    for (const action of actions) {
      switch (action.actionType) {
        case ActionType.ShieldCommitment:
        case ActionType.GeneratedCommitment:
        {
          const shield = action as Shield
          const { treeNumber, treePosition, hash } = shield.commitment
          commitments.push({
            transactionHash,
            blockNumber,
            treeNumber,
            treePosition,
            hash: arrayToByteLength(hash, 32),
            commitmentType: CommitmentType.Shield,
            commitment: {}// Need to populate this later
          })
          break
        }
        case ActionType.EncryptedCommitment:
        case ActionType.TransactCommitment:
        {
          const transact = action as Transact
          nullifiers.push(...transact.nullifiers.map(nullifier => ({
            nullifier,
            transactionHash,
            blockNumber,
            treeNumber: transact.utxoTreeIn
          })))

          commitments.push(...transact.commitments.map((c) => ({
            transactionHash,
            blockNumber,
            treeNumber: c.treeNumber,
            hash: arrayToByteLength(c.hash, 32),
            treePosition: c.treePosition,
            commitmentType: CommitmentType.Transact,
            commitment: {},
          })))
          break
        }
      }
    }
  }

  return { nullifiers, commitments }
}

export { denormalizeBlockData }
