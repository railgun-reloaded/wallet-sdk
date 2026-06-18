import type { NetworkName } from '../network-config.js'

import type { POIJSONRPCMethod } from './node-client-types.js'

/**
 * Error returned by a PPOI node JSON-RPC response.
 */
class PoiNodeRpcError extends Error {
  /** Error class name. */
  override readonly name = 'PoiNodeRpcError'
  /** PPOI node URL that returned the error. */
  readonly url: string
  /** Network targeted by the request. */
  readonly network: NetworkName
  /** JSON-RPC method that failed. */
  readonly method: POIJSONRPCMethod
  /** JSON-RPC error code. */
  readonly code: number
  /** Optional JSON-RPC error data payload. */
  readonly data: unknown | undefined

  /**
   * Build a typed JSON-RPC error.
   * @param params - Error construction params.
   * @param params.url - PPOI node URL that returned the error.
   * @param params.network - Network targeted by the request.
   * @param params.method - JSON-RPC method that failed.
   * @param params.code - JSON-RPC error code.
   * @param params.message - JSON-RPC error message.
   * @param params.data - Optional JSON-RPC error data.
   */
  constructor (
    params: {
      url: string
      network: NetworkName
      method: POIJSONRPCMethod
      code: number
      message: string
      data?: unknown
    }
  ) {
    super(params.message)
    this.url = params.url
    this.network = params.network
    this.method = params.method
    this.code = params.code
    this.data = params.data
  }
}

/**
 * Transport or malformed-response error from a PPOI node request.
 */
class PoiNodeNetworkError extends Error {
  /** Error class name. */
  override readonly name = 'PoiNodeNetworkError'
  /** PPOI node URL that failed. */
  readonly url: string
  /** Network targeted by the request. */
  readonly network: NetworkName
  /** JSON-RPC method that failed. */
  readonly method: POIJSONRPCMethod
  /** HTTP status code when a response was received. */
  readonly status: number | undefined
  /** Raw response body when it could be read. */
  readonly responseBody: string | undefined
  /** Underlying thrown value, if any. */
  override readonly cause: unknown

  /**
   * Build a typed network or decoding error.
   * @param params - Error construction params.
   * @param params.url - PPOI node URL that failed.
   * @param params.network - Network targeted by the request.
   * @param params.method - JSON-RPC method that failed.
   * @param params.message - Error message.
   * @param params.status - Optional HTTP status code.
   * @param params.responseBody - Optional raw response body.
   * @param params.cause - Optional underlying thrown value.
   */
  constructor (
    params: {
      url: string
      network: NetworkName
      method: POIJSONRPCMethod
      message: string
      status?: number | undefined
      responseBody?: string | undefined
      cause?: unknown
    }
  ) {
    super(params.message)
    this.url = params.url
    this.network = params.network
    this.method = params.method
    this.status = params.status
    this.responseBody = params.responseBody
    this.cause = params.cause
  }
}

/**
 * Aggregate error thrown after every configured PPOI node URL fails.
 */
class PoiNodeAllUrlsFailedError extends Error {
  /** Error class name. */
  override readonly name = 'PoiNodeAllUrlsFailedError'
  /** Network targeted by the request. */
  readonly network: NetworkName
  /** JSON-RPC method that failed. */
  readonly method: POIJSONRPCMethod
  /** URLs attempted in order. */
  readonly attemptedUrls: string[]
  /** Per-URL errors captured during retries. */
  readonly errors: Error[]
  /** Last captured error, when at least one URL was attempted. */
  readonly lastError: Error | undefined
  /** Final typed failure exposed through the standard error chain. */
  override readonly cause: Error | undefined

  /**
   * Build an aggregate PPOI node failure.
   * @param params - Error construction params.
   * @param params.network - Network targeted by the request.
   * @param params.method - JSON-RPC method that failed.
   * @param params.attemptedUrls - URLs attempted in order.
   * @param params.errors - Per-URL errors captured during retries.
   */
  constructor (
    params: {
      network: NetworkName
      method: POIJSONRPCMethod
      attemptedUrls: string[]
      errors: Error[]
    }
  ) {
    const lastError = params.errors.at(-1)
    super(
      `All PPOI node URLs failed for ${params.method}: ` +
      `${params.attemptedUrls.join(', ') || '(none)'}`
    )
    this.network = params.network
    this.method = params.method
    this.attemptedUrls = [...params.attemptedUrls]
    this.errors = [...params.errors]
    this.lastError = lastError
    this.cause = lastError
  }
}

export {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError,
  PoiNodeRpcError
}
