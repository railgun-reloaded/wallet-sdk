import { bytesToBigInt, bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import { test } from 'brittle'

import {
  BlindedCommitmentInputError,
  BlindedCommitmentType,
  getBlindedCommitment,
  getBlindedCommitmentForShield,
  getBlindedCommitmentForTransact,
  getBlindedCommitmentForUnshield
} from '../../src/poi'
import type {
  ShieldBlindedCommitmentInput,
  TransactBlindedCommitmentInput,
  UnshieldBlindedCommitmentInput
} from '../../src/poi'

type ShieldFixture = ShieldBlindedCommitmentInput & { expected: string }
type TransactFixture = TransactBlindedCommitmentInput & { expected: string }
type UnshieldFixture = UnshieldBlindedCommitmentInput & { expected: string }

const ADDRESS = hexToBytes('1234567890abcdef1234567890abcdef12345678')

const SHIELD_FIXTURES: ShieldFixture[] = [
  {
    commitment: hexToBytes('13e2a79bbff0e43a0ca22a956f72e94441129d188ac129104fd894b4b61ce6db'),
    npk: bytesToBigInt(hexToBytes('10febc94c4a77ec233da9835ec7a0b5aefc1c9c73e811120579574bbe97af566')),
    treePosition: 6n,
    expected: '242b01e85c7bb5faaa2db9d9a36e1c4c111e1310e4fdd1b020346243b4725861'
  },
  {
    commitment: hexToBytes('2f9e80d50ebfef1d141569591e48dbc7e5509fc5200423848e814017ccd1f973'),
    npk: bytesToBigInt(hexToBytes('0e4ab90e6c9561b69a86023f7f157d29a0beadd72d0d74a364e68d0110d9f4fb')),
    treePosition: 12n,
    expected: '065efbda58e0bf666df4b0b0498945eaef261458f9145f30f114c59c67395fbc'
  },
  {
    commitment: hexToBytes('00112233445566778899aabbccddeeff102132435465768798a9babbdcddfeff'),
    npk: bytesToBigInt(hexToBytes('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')),
    treePosition: 65535n,
    expected: '2d75b77cfccff63cab64041c7a3c512012de4303eeb650cba0f98573e78ee931'
  }
]

const TRANSACT_FIXTURES: TransactFixture[] = [
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

function assertHex (t: { is: (actual: unknown, expected: unknown, message?: string) => void }, actual: Uint8Array, expected: string): void {
  t.is(actual.length, 32)
  t.is(bytesToHex(actual), expected)
}

function assertInputError (
  t: { ok: (value: unknown, message?: string) => void, is: (actual: unknown, expected: unknown, message?: string) => void, fail: (message?: string) => void },
  fn: () => void,
  field: string
): void {
  try {
    fn()
    t.fail('expected input error')
  } catch (error) {
    t.ok(error instanceof BlindedCommitmentInputError)
    if (error instanceof BlindedCommitmentInputError) {
      t.is(error.field, field)
    }
  }
}

test('blinded commitment helpers match pinned community fixtures', (t) => {
  for (const fixture of SHIELD_FIXTURES) {
    assertHex(t, getBlindedCommitmentForShield(fixture), fixture.expected)
  }
  for (const fixture of TRANSACT_FIXTURES) {
    assertHex(t, getBlindedCommitmentForTransact(fixture), fixture.expected)
  }
  for (const fixture of UNSHIELD_FIXTURES) {
    assertHex(t, getBlindedCommitmentForUnshield(fixture), fixture.expected)
  }
})

test('blinded commitment derivation is deterministic across 1000 invocations', (t) => {
  const fixture = TRANSACT_FIXTURES[2]!
  const expected = bytesToHex(getBlindedCommitmentForTransact(fixture))

  for (let i = 0; i < 1000; i += 1) {
    t.is(bytesToHex(getBlindedCommitmentForTransact(fixture)), expected)
  }
})

test('blinded commitment helpers throw typed errors for invalid input', (t) => {
  assertInputError(t, () => {
    getBlindedCommitmentForShield({
      ...SHIELD_FIXTURES[0]!,
      commitment: new Uint8Array(31)
    })
  }, 'commitment')

  assertInputError(t, () => {
    getBlindedCommitmentForUnshield({
      ...UNSHIELD_FIXTURES[0]!,
      toAddress: new Uint8Array(19)
    })
  }, 'toAddress')

  assertInputError(t, () => {
    getBlindedCommitmentForTransact({
      ...TRANSACT_FIXTURES[0]!,
      globalTreePosition: Number.POSITIVE_INFINITY as unknown as bigint
    })
  }, 'globalTreePosition')
})

test('blinded commitment dispatch helper matches direct helpers', (t) => {
  const shield = SHIELD_FIXTURES[0]!
  const transact = TRANSACT_FIXTURES[0]!
  const unshield = UNSHIELD_FIXTURES[0]!

  t.is(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Shield,
      ...shield
    })),
    bytesToHex(getBlindedCommitmentForShield(shield))
  )
  t.is(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Transact,
      ...transact
    })),
    bytesToHex(getBlindedCommitmentForTransact(transact))
  )
  t.is(
    bytesToHex(getBlindedCommitment({
      type: BlindedCommitmentType.Unshield,
      ...unshield
    })),
    bytesToHex(getBlindedCommitmentForUnshield(unshield))
  )
})
