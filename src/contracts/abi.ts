/**
 * ABI surface for RailgunSmartWallet V2 write calls.
 *
 * Fragments are declared inline rather than pulled from a package so the
 * module stays lean and dependency-free for browser bundles. Future write
 * flows extend this file instead of declaring their own fragments.
 */

// @TODO: these fragments duplicate the shared contract ABI package, and are the
// third copy in the workspace alongside the snapshot checkpoint fragments and
// the ones consumers hand-write to decode their own receipts. The shared package
// ships whole-contract artifacts, so importing it to obtain a single event is
// what motivated inlining here. The duplication is a correctness hazard rather
// than a tidiness one: the older V2 artifact declares the Shield event with four
// fields and no `fees` while the deployed contract emits five, so a stale copy
// decodes without error and silently drops the fee. Replace these with named
// fragment exports from the shared package once it publishes them.

/**
 * Minimal ABI fragment for `shield(ShieldRequest[])`.
 *
 * A ShieldRequest pairs a plaintext `preimage` with the `ciphertext` that lets
 * the receiver detect and decrypt the resulting note.
 */
const SHIELD_ABI = [
  {
    name: 'shield',
    type: 'function',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      {
        name: '_shieldRequests',
        type: 'tuple[]',
        components: [
          {
            name: 'preimage',
            type: 'tuple',
            components: [
              { name: 'npk', type: 'bytes32' },
              {
                name: 'token',
                type: 'tuple',
                components: [
                  { name: 'tokenType', type: 'uint8' },
                  { name: 'tokenAddress', type: 'address' },
                  { name: 'tokenSubID', type: 'uint256' }
                ]
              },
              { name: 'value', type: 'uint120' }
            ]
          },
          {
            name: 'ciphertext',
            type: 'tuple',
            components: [
              { name: 'encryptedBundle', type: 'bytes32[3]' },
              { name: 'shieldKey', type: 'bytes32' }
            ]
          }
        ]
      }
    ]
  }
] as const

/**
 * Minimal ABI fragment for the V2.1 `Shield` event.
 *
 * This is the five-field event emitted by RailgunV2_1. The final `fees`
 * array is required to distinguish the net shielded value from the inclusive
 * amount supplied by the caller.
 */
const SHIELD_EVENT_ABI = [
  {
    name: 'Shield',
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'treeNumber', type: 'uint256', indexed: false },
      { name: 'startPosition', type: 'uint256', indexed: false },
      {
        name: 'commitments',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'npk', type: 'bytes32' },
          {
            name: 'token',
            type: 'tuple',
            components: [
              { name: 'tokenType', type: 'uint8' },
              { name: 'tokenAddress', type: 'address' },
              { name: 'tokenSubID', type: 'uint256' }
            ]
          },
          { name: 'value', type: 'uint120' }
        ]
      },
      {
        name: 'shieldCiphertext',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'encryptedBundle', type: 'bytes32[3]' },
          { name: 'shieldKey', type: 'bytes32' }
        ]
      },
      { name: 'fees', type: 'uint256[]', indexed: false }
    ]
  }
] as const

/** Minimal ABI fragment for the public shield fee getter. */
const SHIELD_FEE_ABI = [
  {
    name: 'shieldFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint120' }]
  }
] as const

/** Minimal ERC20 approval surface used by the high-level shield path. */
const ERC20_APPROVAL_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const

/** Minimal ERC721 approval surface used by the high-level shield path. */
const ERC721_APPROVAL_ABI = [
  {
    name: 'getApproved',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    name: 'isApprovedForAll',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' }
    ],
    outputs: []
  },
  {
    name: 'setApprovalForAll',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' }
    ],
    outputs: []
  }
] as const

export {
  ERC20_APPROVAL_ABI,
  ERC721_APPROVAL_ABI,
  SHIELD_ABI,
  SHIELD_EVENT_ABI,
  SHIELD_FEE_ABI
}
