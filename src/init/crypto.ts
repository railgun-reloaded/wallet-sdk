import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

let cryptoInitPromise: Promise<void> | undefined

/**
 * Idempotent wrapper around the cryptography library initializer.
 *
 * Caches the underlying initialization promise so concurrent and repeated
 * calls collapse to a single in-flight invocation. Safe to call any number
 * of times from any number of `RailgunClient` instances in the same process.
 * On rejection the cache is cleared so the next call retries from scratch.
 * @returns A promise that resolves once the cryptography libraries are ready.
 */
const initializeCrypto = (): Promise<void> => {
  if (cryptoInitPromise === undefined) {
    cryptoInitPromise = initializeCryptographyLibs().catch((err) => {
      cryptoInitPromise = undefined
      throw err
    })
  }
  return cryptoInitPromise
}

export { initializeCrypto }
