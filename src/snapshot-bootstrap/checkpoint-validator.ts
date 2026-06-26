import { bytesToHex } from '@railgun-reloaded/bytes'
import type { Address, PublicClient } from 'viem'
import { createPublicClient, http, parseAbi } from 'viem'

import type {
  SnapshotCheckpointValidationInput,
  SnapshotCheckpointValidator
} from './types.js'
import { COMMITMENT_TREE_CAPACITY } from './types.js'

const CHECKPOINT_ABI = parseAbi([
  'function merkleRoot() view returns (bytes32)',
  'function nextLeafIndex() view returns (uint256)',
  'function rootHistory(uint256, bytes32) view returns (bool)',
  'function treeNumber() view returns (uint256)'
])

type SnapshotCheckpointReader = {
  chainID: () => Promise<bigint>
  treeNumber: (blockHeight: bigint) => Promise<bigint>
  nextLeafIndex: (blockHeight: bigint) => Promise<bigint>
  merkleRoot: (blockHeight: bigint) => Promise<string>
  hasRoot: (
    treeNumber: number,
    root: string,
    blockHeight: bigint
  ) => Promise<boolean>
}

type RpcSnapshotCheckpointReaderConfig = {
  rpcURL: string
  proxyContractAddress: string
}

/**
 * Snapshot state differs from the authoritative exact-height checkpoint.
 */
class SnapshotCheckpointMismatchError extends Error {
  /**
   * Create an authoritative checkpoint mismatch.
   * @param message - Mismatch detail.
   */
  constructor (message: string) {
    super(message)
    this.name = 'SnapshotCheckpointMismatchError'
  }
}

/**
 * The authoritative exact-height checkpoint could not be read.
 */
class SnapshotCheckpointUnavailableError extends Error {
  /**
   * Create an exact-height checkpoint availability error.
   * @param message - Availability detail.
   * @param options - Optional error cause.
   */
  constructor (message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SnapshotCheckpointUnavailableError'
  }
}

/**
 * Read exact-height RAILGUN commitment state through historical eth_call.
 */
class RpcSnapshotCheckpointReader implements SnapshotCheckpointReader {
  /** Public client used for network identity and historical calls. */
  readonly #client: PublicClient
  /** RAILGUN proxy contract address. */
  readonly #address: Address

  /**
   * Construct an exact-height RPC checkpoint reader.
   * @param config - RPC URL and proxy contract address.
   */
  constructor (config: RpcSnapshotCheckpointReaderConfig) {
    if (config.rpcURL.trim().length === 0) {
      throw new Error('Snapshot checkpoint RPC URL is empty')
    }
    if (config.proxyContractAddress.trim().length === 0) {
      throw new Error('Snapshot checkpoint contract address is empty')
    }
    this.#client = createPublicClient({ transport: http(config.rpcURL) })
    this.#address = config.proxyContractAddress as Address
  }

  /**
   * Read the endpoint's chain ID.
   * @returns RPC chain ID.
   */
  async chainID (): Promise<bigint> {
    return BigInt(await this.#client.getChainId())
  }

  /**
   * Read the active commitment tree number at an exact block.
   * @param blockHeight - Exact historical block.
   * @returns Active tree number.
   */
  async treeNumber (blockHeight: bigint): Promise<bigint> {
    return this.#client.readContract({
      address: this.#address,
      abi: CHECKPOINT_ABI,
      functionName: 'treeNumber',
      blockNumber: blockHeight
    })
  }

  /**
   * Read the next commitment leaf index at an exact block.
   * @param blockHeight - Exact historical block.
   * @returns Next leaf index.
   */
  async nextLeafIndex (blockHeight: bigint): Promise<bigint> {
    return this.#client.readContract({
      address: this.#address,
      abi: CHECKPOINT_ABI,
      functionName: 'nextLeafIndex',
      blockNumber: blockHeight
    })
  }

  /**
   * Read the active commitment-tree root at an exact block.
   * @param blockHeight - Exact historical block.
   * @returns Hex-encoded root.
   */
  async merkleRoot (blockHeight: bigint): Promise<string> {
    return (await this.#client.readContract({
      address: this.#address,
      abi: CHECKPOINT_ABI,
      functionName: 'merkleRoot',
      blockNumber: blockHeight
    })).toLowerCase()
  }

  /**
   * Check whether a root was accepted for a tree by an exact block.
   * @param treeNumber - Commitment tree number.
   * @param root - Hex-encoded local root.
   * @param blockHeight - Exact historical block.
   * @returns Whether the contract had accepted the root.
   */
  async hasRoot (
    treeNumber: number,
    root: string,
    blockHeight: bigint
  ): Promise<boolean> {
    return this.#client.readContract({
      address: this.#address,
      abi: CHECKPOINT_ABI,
      functionName: 'rootHistory',
      args: [BigInt(treeNumber), root as `0x${string}`],
      blockNumber: blockHeight
    })
  }
}

/**
 * Validate local commitment trees against exact historical contract state.
 * Full prior trees are checked through rootHistory at the same block; the
 * latest tree is bound to treeNumber, nextLeafIndex, and merkleRoot.
 */
class ExactSnapshotCheckpointValidator implements SnapshotCheckpointValidator {
  /** Authoritative checkpoint reader. */
  readonly #reader: SnapshotCheckpointReader

  /**
   * Construct a validator over an injected checkpoint reader.
   * @param reader - Exact-height checkpoint reader.
   */
  constructor (reader: SnapshotCheckpointReader) {
    this.#reader = reader
  }

  /**
   * Validate local commitment state against the authoritative checkpoint.
   * @param input - Local chain, height, and tree state.
   */
  async validate (input: SnapshotCheckpointValidationInput): Promise<void> {
    try {
      await this.#validate(input)
    } catch (error) {
      if (error instanceof SnapshotCheckpointMismatchError) {
        throw error
      }
      throw new SnapshotCheckpointUnavailableError(
        `Unable to validate snapshot checkpoint at block ${input.blockHeight}`,
        { cause: error }
      )
    }
  }

  /**
   * Perform validation while preserving mismatch errors separately from
   * checkpoint availability failures.
   * @param input - Local chain, height, and tree state.
   */
  async #validate (input: SnapshotCheckpointValidationInput): Promise<void> {
    const chainID = await this.#reader.chainID()
    if (chainID !== BigInt(input.chainID)) {
      throw new SnapshotCheckpointMismatchError(
        `Snapshot checkpoint chain ${chainID} does not match ${input.chainID}`
      )
    }

    const trees = [...input.trees].sort((a, b) => a.treeNumber - b.treeNumber)
    if (trees.length === 0) {
      throw new SnapshotCheckpointMismatchError(
        'Snapshot checkpoint has no commitment tree state'
      )
    }
    for (let index = 0; index < trees.length; index += 1) {
      if (trees[index]!.treeNumber !== index) {
        throw new SnapshotCheckpointMismatchError(
          `Snapshot commitment trees are not contiguous at tree ${index}`
        )
      }
      if (trees[index]!.root.length !== 32) {
        throw new SnapshotCheckpointMismatchError(
          `Snapshot tree ${index} root must be 32 bytes`
        )
      }
    }

    const [remoteTreeNumber, remoteNextLeafIndex, remoteMerkleRoot] =
      await Promise.all([
        this.#reader.treeNumber(input.blockHeight),
        this.#reader.nextLeafIndex(input.blockHeight),
        this.#reader.merkleRoot(input.blockHeight)
      ])
    const latestTreeNumber = Number(remoteTreeNumber)
    if (
      !Number.isSafeInteger(latestTreeNumber) ||
      latestTreeNumber !== trees.length - 1
    ) {
      throw new SnapshotCheckpointMismatchError(
        `Snapshot latest tree ${trees.length - 1} does not match ` +
        `checkpoint tree ${remoteTreeNumber}`
      )
    }

    const latestTree = trees[latestTreeNumber]!
    if (BigInt(latestTree.leafCount) !== remoteNextLeafIndex) {
      throw new SnapshotCheckpointMismatchError(
        `Snapshot tree ${latestTreeNumber} leaf count ${latestTree.leafCount} ` +
        `does not match checkpoint next leaf ${remoteNextLeafIndex}`
      )
    }

    const latestRoot = bytesToHex(latestTree.root, { prefix: true }).toLowerCase()
    if (latestRoot !== remoteMerkleRoot.toLowerCase()) {
      throw new SnapshotCheckpointMismatchError(
        `Snapshot tree ${latestTreeNumber} root does not match checkpoint root`
      )
    }

    for (const tree of trees) {
      if (
        tree.treeNumber < latestTreeNumber &&
        tree.leafCount !== COMMITMENT_TREE_CAPACITY
      ) {
        throw new SnapshotCheckpointMismatchError(
          `Snapshot tree ${tree.treeNumber} is not full before later tree ` +
          `${latestTreeNumber}`
        )
      }
      const root = bytesToHex(tree.root, { prefix: true }).toLowerCase()
      if (!await this.#reader.hasRoot(tree.treeNumber, root, input.blockHeight)) {
        throw new SnapshotCheckpointMismatchError(
          `Snapshot tree ${tree.treeNumber} root is not valid at block ` +
          `${input.blockHeight}`
        )
      }
    }
  }
}

/**
 * Create the production exact-height RPC validator.
 * @param config - RPC endpoint and RAILGUN proxy address.
 * @returns Checkpoint validator.
 */
function createRpcSnapshotCheckpointValidator (
  config: RpcSnapshotCheckpointReaderConfig
): SnapshotCheckpointValidator {
  return new ExactSnapshotCheckpointValidator(
    new RpcSnapshotCheckpointReader(config)
  )
}

export {
  ExactSnapshotCheckpointValidator,
  RpcSnapshotCheckpointReader,
  SnapshotCheckpointMismatchError,
  SnapshotCheckpointUnavailableError,
  createRpcSnapshotCheckpointValidator
}
export type {
  RpcSnapshotCheckpointReaderConfig,
  SnapshotCheckpointReader
}
