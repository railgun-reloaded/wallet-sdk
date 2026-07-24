// Golden calldata for the RailgunSmartWallet V2 `shield` call.
//
// Encoded with ethers 6.14.3 from the canonical published contract ABI,
// so it cross-checks this package's viem encoding against an independent ABI
// implementation. Byte values are hex strings and `value` is a decimal string;
// the test converts them to the byte-oriented shapes the encoder accepts.
//
// Covers an ERC20 request with a zero token sub-ID and an ERC721 request with a
// non-zero one, so multi-element array encoding and sub-ID decoding are both
// exercised. Regenerate only if the contract ABI changes.

type ShieldRequestVector = {
  preimage: {
    npk: string
    token: {
      tokenType: number
      tokenAddress: string
      tokenSubID: string
    }
    value: string
  }
  ciphertext: {
    encryptedBundle: [string, string, string]
    shieldKey: string
  }
}

const SHIELD_SIGNATURE =
  'shield(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])'

const SHIELD_SELECTOR = '0x044a40c3'

const SHIELD_REQUESTS: ShieldRequestVector[] = [
  {
    preimage: {
      npk: '0x0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
      token: {
        tokenType: 0,
        tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        tokenSubID: '0x0000000000000000000000000000000000000000000000000000000000000000'
      },
      value: '1000000000000000000'
    },
    ciphertext: {
      encryptedBundle: [
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222222222222222222222222222',
        '0x3333333333333333333333333333333333333333333333333333333333333333'
      ],
      shieldKey: '0x4444444444444444444444444444444444444444444444444444444444444444'
    }
  },
  {
    preimage: {
      npk: '0xfedcba98765432100123456789abcdeffedcba98765432100123456789abcdef',
      token: {
        tokenType: 1,
        tokenAddress: '0x60f80121c31a0d46b5279700f9df786054aa5ee5',
        tokenSubID: '0x00000000000000000000000000000000000000000000000000000000000004d2'
      },
      value: '1'
    },
    ciphertext: {
      encryptedBundle: [
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      ],
      shieldKey: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    }
  }
]

const SHIELD_CALLDATA =
  '0x044a40c3000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400001111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef000000000000000000000000000000000000000000000000000000000000000100000000000000000000000060f80121c31a0d46b5279700f9df786054aa5ee500000000000000000000000000000000000000000000000000000000000004d20000000000000000000000000000000000000000000000000000000000000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

export { SHIELD_CALLDATA, SHIELD_REQUESTS, SHIELD_SELECTOR, SHIELD_SIGNATURE }
export type { ShieldRequestVector }
