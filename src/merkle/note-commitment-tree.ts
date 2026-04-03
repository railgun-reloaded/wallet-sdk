/* eslint camelcase: ["error", {allow: [""]}] */
import { bigintToUint8Array, keccak256, uint8ArrayToBigInt } from '@railgun-reloaded/cryptography'
import { SparseMerkleTree } from '@railgun-reloaded/merkle-tree/sparse-merkle-tree.js'

import { poseidonHash } from './hash'

const SNARK_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

// Maximum depth of Note Commitment Tree
const COMMITMENT_TREE_DEPTH = 16

// Length of each Element
const COMMITMENT_TREE_ELEMENT_LENGTH = 32

// Uint8Array representation of 'Railgun' string
const RAILGUN_BYTES = Uint8Array.from([82, 97, 105, 108, 103, 117, 110])

// Zero Element of Railgun Note Commitment Tree
const COMMITMENT_TREE_ZERO_ELEMENT = bigintToUint8Array(uint8ArrayToBigInt(keccak256(RAILGUN_BYTES)) % SNARK_PRIME)

/**
 * Note Commitment Tree Class for managing note
 */
class NoteCommitmentTree {
  /**
   * MerkleTree representation of note commitment
   */
  #merkleTree: SparseMerkleTree

  /**
   * Last leaf index of insertion
   * SparseMerkleTree keeps tracks of all the element that is inserted, but
   * if we revert some of the nodes, this is not tracked
   * lastLeafIndex: number
   */

  /**
   * Initialize Empty Merkle tree
   * @param createOptions - Optional Parameter to create merkleTree from buffer
   * @param createOptions.buffer - Serialized Object array of merkleTree
   * @param createOptions.length - Size of the array
   */
  constructor (createOptions?: { buffer: Readonly<Uint8Array>, length: number }) {
    if (createOptions) {
      this.#merkleTree = SparseMerkleTree.from({
        buf: createOptions.buffer,
        length: createOptions.length
      }, {
        hashFn: poseidonHash,
        bytesPerElement: COMMITMENT_TREE_ELEMENT_LENGTH
      })
    } else {
      this.#merkleTree = SparseMerkleTree.create({
        depth: COMMITMENT_TREE_DEPTH,
        hashFn: poseidonHash,
        zeroElement: COMMITMENT_TREE_ZERO_ELEMENT
      })
    }
  }

  /**
   * Insert leaf into the MerkleTree starting from specific index
   * @param leafIndex - Starting index of first element
   * @param nodes - Array of elements
   */
  insert (leafIndex: number, nodes: Readonly<Uint8Array | Uint8Array[]>) {
    this.#merkleTree.insert(leafIndex, nodes)
  }

  /**
   * Append leaf after the last element in MerkleTree
   * @param nodes - Array of elements
   */
  append (nodes: Uint8Array | Uint8Array[]) {
    this.#merkleTree.append(nodes)
  }

  /**
   * Undo the last insertion, useful if we want to revert the tree to previous state
   */
  undo () {
    // @TODO: This need to consider the undoing of batch insertion also
    /**
     * The idea is to store merkleProof for current last leaf index, before inserting any other leaf, creating
     * some sort of checkpoint. Whenever we undo the insertion, we can just restore that checkpoint directly into
     * the tree, without any additional calculation.
     *
     * We can also undo the elements, one by one but current implementation calculate the upper level of tree
     * after every insertion which might make this inefficient
     */
    throw new Error('Not implemented')
  }

  /**
   * Get Note Commitment Merkle Tree
   * @returns - Note Commitment Tree Instance
   */
  public get merkleTree () {
    return this.#merkleTree
  }

  /**
   * Generate MerkleProof for given leaf index
   * @param leafIndex - Leaf index in MerkleTree
   * @returns MerkleProof for given leaf index
   */
  proof (leafIndex: number) {
    return this.#merkleTree.proof(leafIndex)
  }

  /**
   * Get MerkleRoot of the tree
   * @returns - MerkleRoot
   */
  root () {
    return this.#merkleTree.root()
  }
}

export { NoteCommitmentTree, COMMITMENT_TREE_ZERO_ELEMENT }
