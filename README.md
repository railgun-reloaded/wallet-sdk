# @railgun-reloaded/wallet-sdk

Top-level SDK for RAILGUN Reloaded. Creates and persists wallets, syncs chain
data, (future) aggregates balances and builds transactions.

## Install

```sh
pnpm add @railgun-reloaded/wallet-sdk
```

## Quick start — create and load a wallet

```typescript
import { randomBytes } from 'node:crypto'

import { RailgunClient } from '@railgun-reloaded/wallet-sdk'
import { Mnemonic, initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

await initializeCryptographyLibs()

const client = new RailgunClient()                        // defaults to ./.railgun

const mnemonic = Mnemonic.generate()                      // or bring your own BIP39 mnemonic
const encryptionKey = new Uint8Array(randomBytes(32))     // caller owns the KDF story

const info = await client.createWallet({
  mnemonic,
  encryptionKey,
  name: 'primary'
})

console.log(info)
// { walletId: '...', name: 'primary', createdAt: Date }

// Later, in another process, with the same encryptionKey:
const ctx = await client.loadWallet(info.walletId, encryptionKey)
console.log({
  railgunAddress: ctx.railgunAddress,     // '0zk1...'
  masterPublicKey: ctx.masterPublicKey,   // Uint8Array(32)
  viewingPublicKey: ctx.viewingPublicKey  // Uint8Array(32)
})

client.close()
```

## Deriving keys without persistence

For scripts and REPLs that don't want a DB:

```typescript
import { deriveWalletKeys } from '@railgun-reloaded/wallet-sdk'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

await initializeCryptographyLibs()

const keys = deriveWalletKeys(mnemonic, 0)
// { walletId, railgunAddress, masterPublicKey, viewingPublicKey,
//   viewingPrivateKey, nullifyingKey }
```

## Multi-wallet from one mnemonic

Pass a non-zero `index` to derive a separate wallet from the same seed:

```typescript
await client.createWallet({ mnemonic, encryptionKey, index: 0, name: 'primary' })
await client.createWallet({ mnemonic, encryptionKey, index: 1, name: 'secondary' })
```

`(mnemonic, index)` is the wallet identity. Re-creating the same pair throws
`WalletAlreadyExistsError` with the existing `walletId` attached.

## Errors

- `InvalidMnemonicError` — BIP39 validation failed.
- `InvalidEncryptionKeyError` — key is not 32 bytes, or decryption auth failed.
- `WalletAlreadyExistsError` — `(mnemonic, index)` collision. `.walletId` points to the existing wallet.
- `WalletNotFoundError` — `loadWallet` called with unknown id.

## Encryption

- Algorithm: AES-256-GCM (via `@railgun-reloaded/cryptography`).
- Blob: `{ mnemonic, index }` JSON-encoded, then encrypted. Wire format is
  `iv (16B) || tag (16B) || ciphertext`.
- The spending key is **never** stored on disk and **not** returned by
  `loadWallet`. A future signing API will re-derive it on demand from the
  encryption key.
- Wallet ID: `sha256(mnemonicSeed || bytes(index.toString(16)))`, matching the
  production `@railgun-community/engine`. Wallets created by production can
  round-trip.

## Storage layout

- Chain DB: `<dataDir>/chains/<chainID>/chain.db` — public, shared across wallets.
- Wallet DB: `<dataDir>/wallets.db` — private, one database, many wallet rows.

Default `dataDir` is `./.railgun`. Override via the constructor:

```typescript
new RailgunClient({ dataDir: '/var/lib/myapp' })
```

For tests, inject a DB:

```typescript
import { createWalletDB } from '@railgun-reloaded/storage'

const walletDB = createWalletDB({ path: ':memory:', runMigrations: true })
const client = new RailgunClient({ walletDB })
```

The client does **not** close an injected DB on `close()` — that responsibility
stays with the caller.

## Status

- ✅ Wallet create / load / list / delete
- ⏳ Chain sync via `client.engine` (exists; not yet wallet-aware)
- 📋 Balance aggregation (planned)
- 📋 Transaction building + signing (planned)
