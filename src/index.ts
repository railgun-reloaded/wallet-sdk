/**
 * Runtime-neutral entry for @railgun-reloaded/wallet-sdk.
 *
 * Re-exports the portable surface so this entry cannot drift from
 * `@railgun-reloaded/wallet-sdk/browser`. Chain and wallet storage contracts
 * are injected by the caller and remain caller-owned. The Node entry
 * (`@railgun-reloaded/wallet-sdk/node`) keeps its filesystem-backed behavior.
 *
 * The events API is absent here. The portable client implements no event
 * support, so exporting the types would document an API that does not exist.
 */

export * from './browser/index.js'
