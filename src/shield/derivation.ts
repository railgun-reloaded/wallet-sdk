import { SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE } from '@railgun-reloaded/wallet-node'
import type { Hex, WalletClient } from 'viem'
import { hexToBytes, keccak256 } from 'viem'

/**
 * Derive a shield private key from an out-of-band EIP-191 signature.
 * @param signature - Hex-encoded signature of `RAILGUN_SHIELD`.
 * @returns The keccak256 digest as exactly 32 bytes.
 */
function shieldPrivateKeyFromSignature (signature: Hex): Uint8Array {
  return hexToBytes(keccak256(signature))
}

/**
 * Ask a viem wallet client to sign the shield derivation message and hash the
 * resulting EIP-191 signature.
 * @param signer - Wallet client with a selected or hoisted account.
 * @returns The derived shield private key as exactly 32 bytes.
 * @throws {Error} If the signer has no selected account.
 * @throws {Error} If the wallet rejects or fails the signature request.
 */
async function deriveShieldPrivateKey (signer: WalletClient): Promise<Uint8Array> {
  const account = signer.account
  if (account === undefined) {
    throw new Error('Shield key derivation requires a wallet client account.')
  }

  const signature = await signer.signMessage({
    account,
    message: SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE
  })
  return shieldPrivateKeyFromSignature(signature)
}

export {
  SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
  shieldPrivateKeyFromSignature
}
