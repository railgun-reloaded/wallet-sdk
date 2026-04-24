# @railgun-reloaded/wallet-sdk

### [WIP]

Top-level SDK for RAILGUN Reloaded. Creates and persists wallets, syncs chain
data, (future) aggregates balances and builds transactions.

## Install

```sh
pnpm add @railgun-reloaded/wallet-sdk
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

## Errors

- `InvalidMnemonicError` — BIP39 validation failed.
- `InvalidEncryptionKeyError` — key is not 32 bytes, or decryption auth failed.
- `WalletAlreadyExistsError` — `(mnemonic, index)` collision. `.walletId` points to the existing wallet.
- `WalletNotFoundError` — `loadWallet` called with unknown id.
