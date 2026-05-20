import type { NetworkName } from '../network-config'

import type { POIJSONRPCMethod } from './node-client-types'

class PoiNodeRpcError extends Error {
  override readonly name = 'PoiNodeRpcError'
  readonly url: string
  readonly network: NetworkName
  readonly method: POIJSONRPCMethod
  readonly code: number
  readonly data: unknown | undefined

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

class PoiNodeNetworkError extends Error {
  override readonly name = 'PoiNodeNetworkError'
  readonly url: string
  readonly network: NetworkName
  readonly method: POIJSONRPCMethod
  readonly status: number | undefined
  readonly responseBody: string | undefined
  override readonly cause: unknown

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

class PoiNodeAllUrlsFailedError extends Error {
  override readonly name = 'PoiNodeAllUrlsFailedError'
  readonly network: NetworkName
  readonly method: POIJSONRPCMethod
  readonly attemptedUrls: string[]
  readonly errors: Error[]
  readonly lastError: Error | undefined

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
  }
}

export {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError,
  PoiNodeRpcError
}
