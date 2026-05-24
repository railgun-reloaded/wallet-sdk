# @railgun-reloaded/wallet-sdk

### [WIP]

Top-level SDK for RAILGUN Reloaded. Creates and persists wallets, syncs chain
data, (future) aggregates balances and builds transactions.

## Install

```sh
npm add @railgun-reloaded/wallet-sdk
```

## Quick start

```typescript
import { randomBytes } from 'node:crypto'

import { RailgunClient } from '@railgun-reloaded/wallet-sdk'
import { Mnemonic, initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

await initializeCryptographyLibs()

const client = new RailgunClient()                        

const mnemonic = Mnemonic.generate()                      
const encryptionKey = new Uint8Array(randomBytes(32))     

const info = await client.createWallet({
  mnemonic,
  encryptionKey,
  name: 'primary'
})

console.log(info)
// { walletId: '...', name: 'primary', createdAt: Date }

const ctx = await client.loadWallet(info.walletId, encryptionKey)
console.log({
  railgunAddress: ctx.railgunAddress,     // '0zk1...'
  masterPublicKey: ctx.masterPublicKey,   // Uint8Array(32)
  viewingPublicKey: ctx.viewingPublicKey  // Uint8Array(32)
})

client.close()
```

## Events

`RailgunClient` exposes typed in-process events. `balance:update` fires after
`decrypt()` or `sync()` changes a wallet's notes and cached balances have been
recalculated. Its payload is a fresh full balance snapshot; applications should
calculate any UI delta they need from their own previous snapshot.

Successful no-op decrypt and sync runs do not emit `balance:update`. Subscribe
to `sync:complete` when the application needs completion notifications even
when balances did not change.

```typescript
const stopBalanceUpdates = client.on(
  'balance:update',
  ({ walletId, chainId, balances, notesAdded, notesSpent }) => {
    console.log({ walletId, chainId, balances, notesAdded, notesSpent })
  },
  { walletId: info.walletId, chainId: 11155111 }
)

const stopSyncCompletion = client.on(
  'sync:complete',
  ({ phase, walletId, chainId }) => {
    console.log({ phase, walletId, chainId })
  },
  { walletId: info.walletId, chainId: 11155111 }
)

// Remove subscriptions when this view or process no longer needs them.
stopBalanceUpdates()
stopSyncCompletion()
```

## Errors

- `InvalidMnemonicError` — BIP39 validation failed.
- `InvalidEncryptionKeyError` — key is not 32 bytes, or decryption auth failed.
- `WalletAlreadyExistsError` — `(mnemonic, index)` collision. `.walletId` points to the existing wallet.
- `WalletNotFoundError` — `loadWallet` called with unknown id.
