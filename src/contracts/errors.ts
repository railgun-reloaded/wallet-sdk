/**
 * Thrown when a transaction is requested for a chain that has no entry in
 * `NETWORK_CONFIG`, so no contract address can be resolved.
 */
class UnsupportedChainError extends Error {
  /** Chain ID that could not be resolved to a configured network. */
  readonly chainId: number

  /**
   * Construct an UnsupportedChainError.
   * @param chainId - The chain ID that is not configured.
   * @param supportedChainIds - Chain IDs that are configured, listed to help
   * callers correct the argument.
   */
  constructor (chainId: number, supportedChainIds: readonly number[]) {
    super(
      `No RAILGUN contract configured for chain ID ${chainId}. Supported chain IDs: ${supportedChainIds.join(', ')}`
    )
    this.name = 'UnsupportedChainError'
    this.chainId = chainId
  }
}

/**
 * Thrown when a shield request carries a token type this package does not
 * support. Only ERC20 and ERC721 tokens can be encoded.
 */
class UnsupportedTokenTypeError extends Error {
  /** The token type value that was rejected. */
  readonly tokenType: number | string

  /**
   * Construct an UnsupportedTokenTypeError.
   * @param tokenType - The unsupported token type value.
   */
  constructor (tokenType: number | string) {
    super(`Unsupported token type ${tokenType}. Only ERC20 and ERC721 are supported.`)
    this.name = 'UnsupportedTokenTypeError'
    this.tokenType = tokenType
  }
}

export { UnsupportedChainError, UnsupportedTokenTypeError }
