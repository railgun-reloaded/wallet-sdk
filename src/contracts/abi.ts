/**
 * ABI surface for RailgunSmartWallet V2 write calls.
 *
 * Fragments are declared inline rather than pulled from a package so the
 * module stays lean and dependency-free for browser bundles. Future write
 * flows extend this file instead of declaring their own fragments.
 */

/**
 * Canonical Solidity signature of `shield`. The 4-byte selector is derived
 * from this string, so tests can assert the selector without hardcoding it.
 */
const SHIELD_FUNCTION_SIGNATURE =
  'shield(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])'

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

export { SHIELD_ABI, SHIELD_FUNCTION_SIGNATURE }
