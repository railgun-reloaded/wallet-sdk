import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DBNewCommitment, DBNewNullifier } from '@railgun-reloaded/storage'

import { CommitmentType, denormalizeBlockData } from '../src/sync'

import { TEST_VECTOR_ALL_ACTIONS, TEST_VECTOR_SHIELD, TEST_VECTOR_TRANSACT } from './test-vector'

test('Should properly denormalize shield action', () => {
  const { nullifiers, unshields, commitments } = denormalizeBlockData(TEST_VECTOR_SHIELD)
  assert.equal(nullifiers.length, 0)
  assert.equal(unshields.length, 0)
  assert.equal(commitments.length, 1)

  const actual : DBNewCommitment = {
    transactionHash: new Uint8Array([255, 208, 145, 7, 185, 59, 157, 185, 63, 72, 154, 148, 96, 245, 28, 29, 81, 76, 219, 183, 177, 161, 127, 166, 74, 130, 108, 186, 197, 172, 175, 33]),
    blockNumber: 6035105n,
    treeNumber: 0,
    hash: new Uint8Array([19, 226, 167, 155, 191, 240, 228, 58, 12, 162, 42, 149, 111, 114, 233, 68, 65, 18, 157, 24, 138, 193, 41, 16, 79, 216, 148, 180, 182, 28, 230, 219]),
    commitmentType: CommitmentType.Shield,
    treePosition: 6,
    commitment: {
      preimage: {
        npk: new Uint8Array([16, 254, 188, 148, 196, 167, 126, 194, 51, 218, 152, 53, 236, 122, 11, 90, 239, 193, 201, 199, 62, 129, 17, 32, 87, 149, 116, 187, 233, 122, 245, 102]),
        token: {
          id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 249, 151, 103, 130, 212, 108, 192, 86, 48, 209, 246, 235, 171, 24, 178, 50, 77, 107, 20]),
          tokenType: 'ERC20',
          tokenSubID: new Uint8Array([0]),
          tokenAddress: new Uint8Array([255, 249, 151, 103, 130, 212, 108, 192, 86, 48, 209, 246, 235, 171, 24, 178, 50, 77, 107, 20]),
        },
        value: 9975000000000000n,
      },
      encryptedBundle: [
        new Uint8Array([92, 18, 217, 41, 117, 244, 112, 195, 171, 45, 112, 162, 87, 192, 223, 105, 227, 239, 74, 29, 123, 60, 11, 32, 198, 43, 125, 88, 28, 133, 154, 75]),
        new Uint8Array([251, 163, 22, 85, 63, 180, 81, 111, 145, 220, 104, 184, 69, 116, 175, 160, 70, 93, 125, 99, 66, 35, 150, 43, 129, 253, 96, 200, 79, 175, 4, 80]),
        new Uint8Array([126, 4, 194, 220, 121, 222, 79, 25, 60, 144, 187, 48, 97, 114, 141, 126, 66, 45, 198, 35, 75, 134, 215, 90, 214, 105, 243, 229, 183, 146, 77, 198]),
      ],
      shieldKey: new Uint8Array([243, 11, 21, 211, 10, 177, 10, 121, 13, 10, 190, 68, 119, 216, 60, 34, 120, 41, 206, 120, 220, 84, 211, 218, 177, 160, 50, 16, 175, 242, 36, 213]),
      fee: undefined
    }
  }
  assert.deepEqual(commitments[0], actual)
})

test('Should properly denormalize mixed actions', () => {
  const { nullifiers, unshields, commitments } = denormalizeBlockData(TEST_VECTOR_ALL_ACTIONS)
  assert.equal(nullifiers.length, 1)
  assert.equal(unshields.length, 1)
  assert.equal(commitments.length, 1)

  const actualNullifiers : DBNewNullifier = {
    nullifier: new Uint8Array([15, 192, 28, 71, 2, 118, 53, 254, 253, 174, 194, 22, 119, 216, 107, 134, 10, 114, 133, 234, 108, 43, 133, 4, 11, 250, 98, 119, 210, 62, 221, 98]),
    transactionHash: new Uint8Array([84, 41, 141, 46, 249, 60, 163, 231, 209, 82, 193, 129, 160, 228, 177, 183, 99, 180, 140, 128, 23, 98, 75, 190, 71, 88, 254, 129, 197, 172, 182, 161]),
    blockNumber: 6093687n,
    treeNumber: 0
  }

  assert.deepEqual(nullifiers[0], actualNullifiers)

  const actualCommitments: DBNewCommitment = {
    transactionHash: new Uint8Array([234, 149, 46, 123, 242, 66, 194, 35, 21, 18, 152, 127, 30, 49, 191, 64, 203, 81, 26, 238, 91, 114, 252, 237, 167, 88, 149, 143, 23, 31, 20, 246]),
    blockNumber: 6093687n,
    treeNumber: 0,
    hash: new Uint8Array([47, 158, 128, 213, 14, 191, 239, 29, 20, 21, 105, 89, 30, 72, 219, 199, 229, 80, 159, 197, 32, 4, 35, 132, 142, 129, 64, 23, 204, 209, 249, 115]),
    commitmentType: CommitmentType.Shield,
    treePosition: 12,
    commitment: {
      preimage: {
        npk: new Uint8Array([14, 74, 185, 14, 108, 149, 97, 182, 154, 134, 2, 63, 127, 21, 125, 41, 160, 190, 173, 215, 45, 13, 116, 163, 100, 230, 141, 1, 16, 217, 244, 251]),
        token: {
          id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 249, 151, 103, 130, 212, 108, 192, 86, 48, 209, 246, 235, 171, 24, 178, 50, 77, 107, 20]),
          tokenType: 'ERC20',
          tokenSubID: new Uint8Array([0]),
          tokenAddress: new Uint8Array([255, 249, 151, 103, 130, 212, 108, 192, 86, 48, 209, 246, 235, 171, 24, 178, 50, 77, 107, 20]),
        },
        value: 9975000000000000n,
      },
      encryptedBundle: [
        new Uint8Array([129, 110, 253, 195, 170, 64, 169, 6, 151, 170, 214, 10, 96, 134, 114, 224, 225, 38, 64, 109, 110, 4, 204, 210, 134, 160, 22, 174, 73, 197, 97, 92]),
        new Uint8Array([54, 21, 51, 22, 149, 142, 174, 146, 92, 211, 200, 125, 246, 162, 97, 40, 111, 63, 47, 26, 232, 240, 33, 221, 229, 127, 22, 226, 241, 34, 12, 29]),
        new Uint8Array([65, 94, 109, 206, 97, 124, 144, 18, 252, 199, 39, 211, 120, 194, 83, 200, 112, 125, 68, 152, 222, 249, 185, 197, 121, 163, 13, 109, 1, 71, 216, 135]),
      ],
      shieldKey: new Uint8Array([223, 109, 201, 225, 185, 149, 82, 106, 243, 46, 164, 105, 190, 215, 163, 172, 107, 17, 145, 143, 16, 108, 153, 137, 246, 155, 21, 207, 58, 24, 6, 66]),
      fee: 1000n
    }
  }

  assert.deepEqual(commitments[0]?.transactionHash, actualCommitments.transactionHash)
})

test('Should properly denormalize transact action', () => {
  const { nullifiers, commitments } = denormalizeBlockData(TEST_VECTOR_TRANSACT)
  assert.equal(nullifiers.length, 2)
  assert.equal(commitments.length, 2)

  const actualNullifiers : DBNewNullifier[] = [
    {
      nullifier: new Uint8Array([41, 81, 26, 213, 59, 195, 233, 173, 136, 61, 193, 141, 248, 115, 118, 49, 86, 65, 167, 205, 146, 41, 130, 187, 34, 156, 176, 229, 126, 234, 153, 7]),
      transactionHash: new Uint8Array([52, 181, 160, 214, 37, 139, 200, 212, 12, 8, 62, 228, 102, 182, 81, 8, 77, 28, 42, 241, 2, 1, 20, 173, 40, 165, 207, 255, 160, 68, 65, 25]),
      blockNumber: 5970612n,
      treeNumber: 0
    },
    {
      nullifier: new Uint8Array([33, 16, 134, 31, 39, 182, 230, 148, 10, 176, 44, 30, 77, 216, 138, 20, 153, 188, 127, 237, 167, 67, 239, 3, 45, 207, 95, 58, 120, 9, 95, 239]),
      transactionHash: new Uint8Array([52, 181, 160, 214, 37, 139, 200, 212, 12, 8, 62, 228, 102, 182, 81, 8, 77, 28, 42, 241, 2, 1, 20, 173, 40, 165, 207, 255, 160, 68, 65, 25]),
      blockNumber: 5970612n,
      treeNumber: 0
    }
  ]
  assert.deepEqual(nullifiers, actualNullifiers)

  const actualCommitments : DBNewCommitment[] = [
    {
      hash: new Uint8Array([10, 190, 120, 189, 128, 32, 154, 236, 21, 177, 233, 156, 189, 252, 40, 154, 5, 92, 125, 127, 114, 98, 117, 224, 22, 213, 22, 79, 151, 147, 66, 21]),
      transactionHash: new Uint8Array([52, 181, 160, 214, 37, 139, 200, 212, 12, 8, 62, 228, 102, 182, 81, 8, 77, 28, 42, 241, 2, 1, 20, 173, 40, 165, 207, 255, 160, 68, 65, 25]),
      blockNumber: 5970612n,
      treeNumber: 0,
      commitmentType: CommitmentType.Transact,
      treePosition: 3,
      commitment: {
        ciphertext: {
          iv: new Uint8Array([188, 181, 119, 5, 55, 142, 50, 172, 141, 77, 236, 127, 26, 164, 132, 227]),
          tag: new Uint8Array([113, 223, 132, 26, 189, 176, 28, 70, 248, 14, 137, 215, 119, 5, 234, 94]),
          data: [
            new Uint8Array([132, 16, 233, 40, 141, 36, 229, 202, 169, 212, 54, 97, 192, 162, 82, 104, 58, 31, 100, 167, 82, 146, 100, 67, 220, 163, 237, 68, 220, 207, 102, 83]),
            new Uint8Array([117, 216, 33, 33, 165, 105, 230, 79, 190, 43, 195, 54, 198, 189, 226, 28, 123, 48, 170, 210, 93, 63, 87, 8, 249, 73, 36, 224, 106, 50, 9, 161]),
            new Uint8Array([199, 183, 126, 45, 95, 77, 173, 17, 21, 4, 140, 115, 120, 206, 160, 40, 244, 39, 194, 208, 164, 136, 249, 83, 67, 112, 136, 178, 131, 253, 69, 170]),
          ],
        },
        blindedSenderViewingKey: new Uint8Array([180, 5, 220, 137, 17, 169, 166, 146, 186, 210, 218, 115, 143, 182, 195, 147, 31, 248, 86, 193, 177, 89, 43, 184, 162, 115, 243, 214, 211, 175, 184, 254]),
        blindedReceiverViewingKey: new Uint8Array([63, 18, 221, 197, 195, 100, 109, 71, 74, 148, 163, 26, 250, 34, 191, 67, 146, 227, 23, 187, 154, 81, 189, 14, 232, 134, 212, 41, 13, 162, 97, 59]),
        annotationData: new Uint8Array([199, 25, 96, 39, 63, 228, 115, 205, 229, 44, 26, 103, 195, 67, 246, 60, 173, 212, 238, 49, 164, 178, 108, 199, 210, 151, 202, 129, 96, 145, 29, 69, 214, 78, 197, 79, 49, 192, 12, 169, 197, 176, 127, 149, 103, 253, 123, 144, 212, 26, 54, 166, 82, 187, 149, 167, 120, 240, 194, 167, 37, 26]),
        memo: new Uint8Array([]),
      }
    },
    {
      hash: new Uint8Array([9, 215, 112, 17, 17, 224, 115, 223, 244, 174, 83, 80, 115, 36, 51, 66, 194, 206, 4, 167, 210, 156, 246, 85, 123, 198, 30, 143, 197, 225, 232, 230]),
      transactionHash: new Uint8Array([52, 181, 160, 214, 37, 139, 200, 212, 12, 8, 62, 228, 102, 182, 81, 8, 77, 28, 42, 241, 2, 1, 20, 173, 40, 165, 207, 255, 160, 68, 65, 25]),
      blockNumber: 5970612n,
      treeNumber: 0,
      commitmentType: CommitmentType.Transact,
      treePosition: 4,
      commitment: {
        ciphertext: {
          iv: new Uint8Array([213, 189, 198, 24, 18, 196, 141, 87, 21, 16, 97, 234, 231, 72, 29, 246]),
          tag: new Uint8Array([113, 4, 244, 157, 43, 12, 25, 98, 88, 153, 53, 99, 58, 58, 138, 19]),
          data: [
            new Uint8Array([166, 180, 128, 81, 36, 193, 13, 10, 59, 248, 32, 20, 238, 242, 107, 52, 126, 8, 79, 138, 250, 103, 3, 208, 24, 19, 208, 17, 176, 33, 98, 115]),
            new Uint8Array([205, 25, 112, 196, 135, 250, 150, 200, 115, 141, 112, 205, 52, 205, 119, 9, 168, 38, 182, 151, 218, 27, 66, 204, 232, 126, 150, 202, 58, 62, 115, 246]),
            new Uint8Array([162, 216, 183, 2, 63, 164, 139, 119, 159, 8, 223, 173, 129, 157, 255, 153, 19, 23, 188, 244, 130, 16, 107, 239, 41, 232, 180, 47, 155, 198, 223, 233]),
          ],
        },
        blindedSenderViewingKey: new Uint8Array([93, 34, 72, 99, 214, 13, 30, 7, 214, 64, 237, 41, 119, 6, 36, 244, 5, 168, 42, 69, 124, 245, 241, 43, 148, 208, 217, 88, 226, 233, 135, 196]),
        blindedReceiverViewingKey: new Uint8Array([93, 34, 72, 99, 214, 13, 30, 7, 214, 64, 237, 41, 119, 6, 36, 244, 5, 168, 42, 69, 124, 245, 241, 43, 148, 208, 217, 88, 226, 233, 135, 196]),
        annotationData: new Uint8Array([218, 73, 15, 79, 8, 241, 227, 237, 77, 119, 171, 120, 19, 154, 48, 191, 89, 50, 174, 123, 136, 118, 14, 54, 143, 55, 35, 1, 248, 207, 19, 250, 103, 193, 72, 53, 4, 253, 136, 227, 143, 141, 57, 152, 21, 220, 60, 138, 107, 235, 226, 209, 13, 166, 203, 6, 193, 56, 206, 46, 126, 125]),
        memo: new Uint8Array([]),
      }
    }
  ]
  assert.deepEqual(commitments, actualCommitments)
})
