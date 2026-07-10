import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainStorage, DBNewCommitment, DBNewNullifier, DBNewRailgunTransaction, DBNewUnshield } from '@railgun-reloaded/storage'

import { NoteCommitmentTree } from '../merkle/index.js'

import { denormalizeBlockData } from './event-processor.js'

/**
 * Inputs for `drainChainToTip`. Portable: everything is injected, so the
 * same drain loop serves the Node engine and the browser engine.
 */
type ChainSyncParams = {
  /** Chain storage contract the drained blocks are written through. */
  storage: ChainStorage
  /** Aggregated data source yielding EVM blocks. */
  dataSource: SourceAggregator<EVMBlock>
  /** In-memory note commitment trees, keyed by treeNumber. Mutated in place. */
  trees: Map<number, NoteCommitmentTree>
  /** Chain ID the sync cursor is scoped to. */
  chainID: number
  /** Block to begin syncing from (inclusive). */
  startHeight: bigint
  /** Optional ceiling; the loop exits after writing a block at or above it. */
  endBlock?: bigint | undefined
  /** Fired after each batch insert with the highest block number in it. */
  onBatch?: ((lastBlock: bigint) => void) | undefined
  /** Whether to persist PPOI TXID rows. Defaults to true. */
  persistRailgunTransactions?: boolean
  /** Optional logger. */
  log?: (message: string) => void
}

/**
 * Load all persisted merkle trees from chain storage into the in-memory map.
 * Trees are returned ordered by treeNumber, so map insertion order matches
 * on-disk order.
 * @param storage - Chain storage contract to read trees from.
 * @param trees - In-memory tree map to populate. Mutated in place.
 */
async function loadMerkleTrees (
  storage: ChainStorage,
  trees: Map<number, NoteCommitmentTree>
): Promise<void> {
  for (const tree of await storage.getAllMerkleTrees()) {
    trees.set(tree.treeNumber, new NoteCommitmentTree({
      buffer: tree.leaves,
      length: tree.leafCount
    }))
  }
}

/**
 * Insert one batch of denormalized chain data: append commitments to the
 * in-memory trees, serialize the touched trees, and persist everything
 * atomically through the storage contract.
 * @param params - Chain sync inputs carrying storage, trees, and chainID.
 * @param nullifierBatch - Batched Nullifiers to insert
 * @param commitmentBatch - Batched Commitments to insert
 * @param unshieldBatch - Batched Unshields to insert
 * @param railgunTransactionBatch - Batched Railgun TXID transactions to insert
 * @param blockNumber - Block number of last batched entry
 */
async function insertChainBatch (
  params: ChainSyncParams,
  nullifierBatch: DBNewNullifier[],
  commitmentBatch: DBNewCommitment[],
  unshieldBatch: DBNewUnshield[],
  railgunTransactionBatch: DBNewRailgunTransaction[],
  blockNumber: bigint
): Promise<void> {
  const { storage, trees } = params

  // Update commitmentTree
  const treeSortedCommitments = new Map<number, { treePosition: number, hash: Uint8Array }[]>()
  commitmentBatch.forEach((c) => {
    const { treeNumber, treePosition, hash } = c
    if (!treeSortedCommitments.has(treeNumber)) {
      treeSortedCommitments.set(treeNumber, [{ treePosition, hash: hash as Uint8Array }])
    } else {
      treeSortedCommitments.get(treeNumber)!.push({ treePosition, hash: hash as Uint8Array })
    }
  })

  for (const [key, val] of treeSortedCommitments) {
    if (!trees.has(key)) {
      trees.set(key, new NoteCommitmentTree())
    }
    const commitments = val.sort((a, b) => a.treePosition - b.treePosition)
    if (commitments.length > 0) {
      trees.get(key)!.append(commitments.map(c => c.hash))
    }
  }

  const merkleTreeRows = [...treeSortedCommitments.keys()].map((key) => {
    const tree = trees.get(key)!
    const { length, buf } = tree.merkleTree.serialize()
    return {
      treeNumber: key,
      leafCount: length,
      leaves: buf
    }
  })

  await storage.insertScanBatch({
    chainID: params.chainID,
    blockNumber,
    nullifiers: nullifierBatch,
    commitments: commitmentBatch,
    unshields: unshieldBatch,
    railgunTransactions: railgunTransactionBatch,
    merkleTrees: merkleTreeRows
  })
}

/**
 * Drive the data source iterator from `startHeight` until it terminates,
 * batching writes through the chain storage contract. Stops early when a
 * block at `endBlock` (or past it) has been ingested. Returns the last block
 * number written, or `undefined` when the iterator yielded nothing.
 * @param params - Injected storage, data source, trees, and scan bounds.
 * @returns Last block number persisted, or `undefined`.
 */
async function drainChainToTip (params: ChainSyncParams): Promise<bigint | undefined> {
  const { storage, dataSource, startHeight, endBlock, onBatch } = params
  const persistRailgunTransactions = params.persistRailgunTransactions !== false

  params.log?.(`Syncing event from height ${startHeight}`)
  const eventIterator = dataSource.from({
    startHeight,
    endHeight: endBlock,
    liveSync: false,
  })

  const batchInsertSize = 100
  let nullifierBatch: DBNewNullifier[] = []
  let commitmentBatch: DBNewCommitment[] = []
  let unshieldBatch: DBNewUnshield[] = []
  let railgunTransactionBatch: DBNewRailgunTransaction[] = []

  let blocksInBatch = 0
  let lastBlockNumber: bigint | undefined
  for await (const block of eventIterator) {
    const { nullifiers, commitments, unshields, railgunTransactions } = denormalizeBlockData(block)
    nullifierBatch.push(...nullifiers)
    commitmentBatch.push(...commitments)
    unshieldBatch.push(...unshields)
    if (persistRailgunTransactions) {
      railgunTransactionBatch.push(...railgunTransactions)
    }
    blocksInBatch += 1
    lastBlockNumber = block.number

    if (blocksInBatch >= batchInsertSize) {
      await insertChainBatch(
        params,
        nullifierBatch,
        commitmentBatch,
        unshieldBatch,
        railgunTransactionBatch,
        block.number
      )
      onBatch?.(block.number)
      blocksInBatch = 0
      commitmentBatch = []
      nullifierBatch = []
      unshieldBatch = []
      railgunTransactionBatch = []
    }

    if (endBlock !== undefined && block.number >= endBlock) {
      break
    }
  }

  if (blocksInBatch > 0 && lastBlockNumber !== undefined) {
    await insertChainBatch(
      params,
      nullifierBatch,
      commitmentBatch,
      unshieldBatch,
      railgunTransactionBatch,
      lastBlockNumber
    )
    onBatch?.(lastBlockNumber)
  }

  // Iterators only yield event-bearing blocks, so `lastBlockNumber` lags the
  // actual walked range when the tail (or interior gaps) emit no RAILGUN
  // events. The aggregator tracks the actual high-water mark across its
  // sources — read it back so the cursor reflects coverage, not just the
  // last event. Otherwise re-syncs replay the empty tail and the wallet
  // decryptor reads a stale `toBlock`.
  const coveredThrough = dataSource.lastIteratedHeight ?? lastBlockNumber
  if (coveredThrough !== undefined) {
    const persisted = (await storage.getSyncState(params.chainID))?.lastBlockHeight
    if (persisted === undefined || coveredThrough > persisted) {
      await storage.updateSyncState(params.chainID, coveredThrough)
    }
  }

  return coveredThrough
}

export { drainChainToTip, loadMerkleTrees }
export type { ChainSyncParams }
