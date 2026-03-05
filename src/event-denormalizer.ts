import type { NewCommitment, NewNullifier } from '@reloaded/storage'
import type { EVMBlock, Transact } from 'scanner'
import { ActionType } from 'scanner'

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
            hash: c.hash,
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
