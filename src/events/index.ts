/**
 * TODO: the events API (`EventBus`, event filters, `client.on()`) is Node-only
 * today and reaches consumers through `@railgun-reloaded/wallet-sdk/node`. Port
 * it to the portable entry before wallets build UIs on event subscriptions.
 */

export { EventBus } from './bus.js'
export type {
  BalanceUpdateEvent,
  BusErrorEvent,
  EventFilter,
  EventHandler,
  RailgunEventMap,
  SyncCompleteEvent,
  SyncErrorEvent,
  SyncPhaseTag,
  SyncProgressEvent,
  SyncStartEvent
} from './types.js'
