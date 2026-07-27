/**
 * Shield write-path module: builds unsigned shield transactions.
 *
 * Re-exported from the root, Node, and browser entries. Pulls in no Node
 * built-ins and none of the client, engine, or storage surfaces, so the browser
 * bundle check can verify this path in isolation.
 */

export { InvalidShieldAmountError } from './errors.js'
export { shield } from './shield.js'
export type {
  ShieldBaseParams,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldParams,
  ShieldResult
} from './shield.js'
