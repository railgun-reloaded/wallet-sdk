import type { NewCommitment, NewNullifier } from '@reloaded/storage'
import type { EVMBlock, Shield, Transact } from 'scanner'
import { ActionType } from 'scanner'

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
  nullifiers: NewNullifier[]
  commitments: NewCommitment[]
} {
  const nullifiers = new Array<NewNullifier>()
  const commitments = new Array<NewCommitment>()

  const blockNumber = block.number
  for (const tx of block.transactions) {
    const txHash = tx.hash
    const actions = tx.actions.flat()
    for (const action of actions) {
      switch (action.actionType) {
        case ActionType.ShieldCommitment:
        case ActionType.GeneratedCommitment:
        {
          const shield = action as Shield
          const { treeNumber, treePosition, hash } = shield.commitment
          commitments.push({
            txid: txHash,
            blockNumber,
            treeId: treeNumber,
            leafIndex: BigInt(treePosition),
            hash: arrayToByteLength(hash, 32)
          })
          break
        }
        case ActionType.EncryptedCommitment:
        case ActionType.TransactCommitment:
        {
          const transact = action as Transact
          nullifiers.push(...transact.nullifiers.map(nullifier => ({
            nullifier,
            txid: txHash,
            blockNumber,
            treeId: transact.utxoTreeIn
          })))
          commitments.push(...transact.commitments.map((c) => ({
            txid: txHash,
            blockNumber,
            treeId: c.treeNumber,
            hash: arrayToByteLength(c.hash, 32),
            leafIndex: BigInt(c.treePosition)
          })))
          break
        }
      }
    }
  }

  return { nullifiers, commitments }
}

export { denormalizeBlockData }
