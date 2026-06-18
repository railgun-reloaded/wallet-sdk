import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToBigInt, bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'

import type {
  ShieldOrTransactBlindedCommitmentInput,
  UnshieldBlindedCommitmentInput
} from '../../src/poi/index.js'
import {
  BlindedCommitmentInputError,
  BlindedCommitmentType,
  getBlindedCommitment,
  getBlindedCommitmentForShieldOrTransact,
  getBlindedCommitmentForUnshield
} from '../../src/poi/index.js'

type ShieldOrTransactFixture = ShieldOrTransactBlindedCommitmentInput & { expected: string }
type UnshieldFixture = UnshieldBlindedCommitmentInput & { expected: string }

const ADDRESS = hexToBytes('1234567890abcdef1234567890abcdef12345678')

const SHIELD_FIXTURES: ShieldOrTransactFixture[] = [
  {
    commitment: hexToBytes('13e2a79bbff0e43a0ca22a956f72e94441129d188ac129104fd894b4b61ce6db'),
    npk: bytesToBigInt(hexToBytes('10febc94c4a77ec233da9835ec7a0b5aefc1c9c73e811120579574bbe97af566')),
    globalTreePosition: 6n,
    expected: '242b01e85c7bb5faaa2db9d9a36e1c4c111e1310e4fdd1b020346243b4725861'
  },
  {
    commitment: hexToBytes('2f9e80d50ebfef1d141569591e48dbc7e5509fc5200423848e814017ccd1f973'),
    npk: bytesToBigInt(hexToBytes('0e4ab90e6c9561b69a86023f7f157d29a0beadd72d0d74a364e68d0110d9f4fb')),
    globalTreePosition: 12n,
    expected: '065efbda58e0bf666df4b0b0498945eaef261458f9145f30f114c59c67395fbc'
  },
  {
    commitment: hexToBytes('00112233445566778899aabbccddeeff102132435465768798a9babbdcddfeff'),
    npk: bytesToBigInt(hexToBytes('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')),
    globalTreePosition: 65535n,
    expected: '2d75b77cfccff63cab64041c7a3c512012de4303eeb650cba0f98573e78ee931'
  }
]

const TRANSACT_FIXTURES: ShieldOrTransactFixture[] = [
  {
    commitment: hexToBytes('0abe78bd80209aec15b1e99cbdfc289a055c7d7f726275e016d5164f97934215'),
    npk: bytesToBigInt(hexToBytes('3f12ddc5c3646d474a94a31afa22bf4392e317bb9a51bd0ee886d4290da2613b')),
    globalTreePosition: 3n,
    expected: '2d4adb089b715782791d39a458f09627e507690625a7821c716a584bdd0f45dd'
  },
  {
    commitment: hexToBytes('09d7701111e073dff4ae535073243342c2ce04a7d29cf6557bc61e8fc5e1e8e6'),
    npk: bytesToBigInt(hexToBytes('5d224863d60d1e07d640ed29770624f405a82a457cf5f12b94d0d958e2e987c4')),
    globalTreePosition: 4n,
    expected: '25598909e3c88e60d17c312635f751d03284734df5757dd2f0397405cc1174d9'
  },
  {
    commitment: hexToBytes('ffeeddccbbaa99887766554433221100efcdab8967452301fedcba9876543210'),
    npk: bytesToBigInt(hexToBytes('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100')),
    globalTreePosition: 65541n,
    expected: '2949c953f84ebba68020a7f93bb0f23f628ba9ccd97cc97234aee057063b313b'
  }
]

const UNSHIELD_FIXTURES: UnshieldFixture[] = [
  {
    railgunTxid: hexToBytes('301e40ff3d4432b9c9b3273659a966b3885099dd50a44b5caf9255f14d6a8a1b'),
    toAddress: ADDRESS,
    value: 1n,
    expected: '301e40ff3d4432b9c9b3273659a966b3885099dd50a44b5caf9255f14d6a8a1b'
  },
  {
    railgunTxid: hexToBytes('0794937a4879371914d60c60b01524f8255894e7fb66af45d82922435244b372'),
    toAddress: ADDRESS,
    value: 1000000000000000000n,
    expected: '0794937a4879371914d60c60b01524f8255894e7fb66af45d82922435244b372'
  },
  {
    railgunTxid: hexToBytes('ffffffffffffffffffffffffffffffff00000000000000000000000000000001'),
    toAddress: ADDRESS,
    value: 42n,
    expected: 'ffffffffffffffffffffffffffffffff00000000000000000000000000000001'
  }
]

/**
 * Assert that bytes match an expected 32-byte hex string.
 * @param actual - Actual byte output.
 * @param expected - Expected lowercase hex string.
 */
function assertHex (actual: Uint8Array, expected: string): void {
  assert.strictEqual(actual.length, 32)
  assert.strictEqual(bytesToHex(actual), expected)
}

/**
 * Assert that a derivation call fails validation for one field.
 * @param fn - Function expected to throw.
 * @param field - Expected failing field name.
 */
function assertInputError (fn: () => void, field: string): void {
  try {
    fn()
    assert.fail('expected input error')
  } catch (error) {
    assert.ok(error instanceof BlindedCommitmentInputError)
    assert.strictEqual((error as BlindedCommitmentInputError).field, field)
  }
}

test('blinded commitment helpers match pinned community fixtures', () => {
  for (const fixture of SHIELD_FIXTURES) {
    assertHex(getBlindedCommitmentForShieldOrTransact(fixture), fixture.expected)
  }
  for (const fixture of TRANSACT_FIXTURES) {
    assertHex(getBlindedCommitmentForShieldOrTransact(fixture), fixture.expected)
  }
  for (const fixture of UNSHIELD_FIXTURES) {
    assertHex(getBlindedCommitmentForUnshield(fixture), fixture.expected)
  }
})

test('blinded commitment derivation is deterministic across 1000 invocations', () => {
  const fixture = TRANSACT_FIXTURES[2]!
  const expected = bytesToHex(getBlindedCommitmentForShieldOrTransact(fixture))

  for (let i = 0; i < 1000; i += 1) {
    assert.strictEqual(bytesToHex(getBlindedCommitmentForShieldOrTransact(fixture)), expected)
  }
})

test('blinded commitment helpers throw typed errors for invalid input', () => {
  assertInputError(() => {
    getBlindedCommitmentForShieldOrTransact({
      ...SHIELD_FIXTURES[0]!,
      commitment: new Uint8Array(31)
    })
  }, 'commitment')

  assertInputError(() => {
    getBlindedCommitmentForUnshield({
      ...UNSHIELD_FIXTURES[0]!,
      toAddress: new Uint8Array(19)
    })
  }, 'toAddress')

  assertInputError(() => {
    getBlindedCommitmentForShieldOrTransact({
      ...TRANSACT_FIXTURES[0]!,
      globalTreePosition: Number.POSITIVE_INFINITY as unknown as bigint
    })
  }, 'globalTreePosition')
})

test('blinded commitment dispatch helper matches direct helpers', () => {
  const shield = SHIELD_FIXTURES[0]!
  const transact = TRANSACT_FIXTURES[0]!
  const unshield = UNSHIELD_FIXTURES[0]!

  assert.strictEqual(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Shield,
      ...shield
    })),
    bytesToHex(getBlindedCommitmentForShieldOrTransact(shield))
  )
  assert.strictEqual(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Transact,
      ...transact
    })),
    bytesToHex(getBlindedCommitmentForShieldOrTransact(transact))
  )
  assert.strictEqual(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Unshield,
      ...unshield
    })),
    bytesToHex(getBlindedCommitmentForUnshield(unshield))
  )
})

test('shield blinded commitment uses global tree position (tree > 0 differs from per-tree)', () => {
  // Synthetic fixture: same (commitment, npk) in tree 1 vs tree 0.
  // Per-tree formula would produce identical blindeds; global formula must not.
  const commitment = hexToBytes('13e2a79bbff0e43a0ca22a956f72e94441129d188ac129104fd894b4b61ce6db')
  const npk = bytesToBigInt(hexToBytes('10febc94c4a77ec233da9835ec7a0b5aefc1c9c73e811120579574bbe97af566'))
  const TREE_LEAF_COUNT = 65536n
  const treePosition = 6n

  const tree0Global = getBlindedCommitmentForShieldOrTransact({ commitment, npk, globalTreePosition: treePosition })
  const tree1Global = getBlindedCommitmentForShieldOrTransact({ commitment, npk, globalTreePosition: TREE_LEAF_COUNT + treePosition })

  assert.notStrictEqual(bytesToHex(tree0Global), bytesToHex(tree1Global))
})
