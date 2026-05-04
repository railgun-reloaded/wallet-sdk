import { hexToBytes } from '@railgun-reloaded/bytes'
import type { TokenDataGetter } from '@railgun-reloaded/wallet-node'
import { TokenType } from '@railgun-reloaded/wallet-node'

/**
 * ERC-20-only TokenDataGetter. The token hash for an ERC-20 is the address
 * left-padded to 32 bytes; recover the address by taking the last 40 hex
 * chars and pair it with `tokenType: ERC20` and a zero `tokenSubID`.
 *
 * NFT support (ERC-721/1155) requires reading the on-chain token registry
 * and is not implemented here.
 */
const erc20TokenDataGetter: TokenDataGetter = {
  /**
   * Resolve a token hash to ERC-20 token data.
   * @param _txidVersion - Unused for ERC-20 lookup.
   * @param _chain - Unused for ERC-20 lookup.
   * @param tokenHash - 32-byte hex token hash (with or without 0x prefix).
   * @returns Token data with the address extracted from the hash.
   */
  async getTokenDataFromHash (_txidVersion, _chain, tokenHash) {
    const cleanHash = tokenHash.startsWith('0x') ? tokenHash.slice(2) : tokenHash
    const addressHex = cleanHash.slice(24)
    return {
      tokenType: TokenType.ERC20,
      tokenAddress: hexToBytes(addressHex),
      tokenSubID: new Uint8Array(32),
    }
  }
}

export { erc20TokenDataGetter }
