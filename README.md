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

import { RailgunClient } from '@railgun-reloaded/wallet-sdk/node'
import { Mnemonic } from '@railgun-reloaded/wallet-node'

const client = await RailgunClient.create()

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

await client.close()
```

## Initialization

`RailgunClient` initializes the underlying cryptography libraries (ed25519,
circomlib, EdDSA) automatically on the first call to `loadWallet`, `decrypt`,
or `sync`. The init is cached, so subsequent calls and additional
`RailgunClient` instances in the same process share the same one-time setup.

`createWallet` does not trigger init — it only runs BIP39 validation, ID
derivation, and AES-GCM blob encryption.

To pay the init cost up front — for example at app startup, before serving
any UI that depends on wallet ops — call `initialize()` explicitly:

```typescript
const client = await RailgunClient.create()
await client.initialize()
```

The same effect is available as a stand-alone function for callers that
don't have a client at hand (e.g. direct `deriveWalletKeys` usage):

```typescript
import { initializeCrypto } from '@railgun-reloaded/wallet-sdk'

await initializeCrypto()
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

## Snapshot bootstrap

A fresh wallet can bootstrap its canonical historical prefix (deployment block →
`endHeight`) from an immutable snapshot instead of replaying it through Subsquid.
You assemble the `SourceAggregator` (and bring snapshot's `decodeArtifact`); the
SDK owns the protocol — staging snapshot blocks as untrusted state, validating
their exact on-chain checkpoint, promoting `chain.db` atomically, and recovering
interrupted attempts. Subsquid then continues from `endHeight + 1`.

```typescript
import {
  bootstrapSnapshotAtomically,
  createRpcSnapshotCheckpointValidator,
  NETWORK_CONFIG, NetworkName, RailgunEngine
} from '@railgun-reloaded/wallet-sdk/node'
import { SnapshotProvider, SourceAggregator, SubsquidProvider } from '@railgun-reloaded/scanner'
import { decodeArtifact } from '@railgun-reloaded/snapshot'

const config = NETWORK_CONFIG[NetworkName.EthereumSepolia]

// Stage + validate the exact checkpoint + promote atomically.
// chainID and deployment start height come from NETWORK_CONFIG.
const result = await bootstrapSnapshotAtomically({
  network: NetworkName.EthereumSepolia,
  cid,
  endHeight, // from the snapshot manifest
  dataSource: new SourceAggregator([
    new SnapshotProvider({ ipfsHash: cid, gateways, decodeArtifact }),
    new SubsquidProvider(subsquidURL)
  ]),
  checkpointValidator: createRpcSnapshotCheckpointValidator({
    rpcURL: config.rpcURL,
    proxyContractAddress: config.proxyContractAddress
  })
})
// result.status === 'promoted' | 'skipped'

// Continue from the persisted cursor (endHeight + 1).
const engine = new RailgunEngine()
engine.setDataSource(new SourceAggregator([new SubsquidProvider(subsquidURL)]))
await engine.setNetwork(NetworkName.EthereumSepolia)
await engine.scan()
```

A chain DB already holding trusted sync state (`lastBlockHeight > 0`) is left
untouched (`status: 'skipped'`). The trusted cursor is never advanced before
validation and atomic promotion succeed, so any fetch, integrity, validation, or
promotion failure leaves no trusted state and falls back to a full Subsquid scan.
Interrupted attempts are cleaned up on the next run — no manual `chain.db`
deletion. Pass your own `SnapshotCheckpointValidator` to validate against a
different authority.

## Errors

- `InvalidMnemonicError` — BIP39 validation failed.
- `InvalidEncryptionKeyError` — key is not 32 bytes, or decryption auth failed.
- `WalletAlreadyExistsError` — `(mnemonic, index)` collision. `.walletId` points to the existing wallet.
- `WalletNotFoundError` — `loadWallet` called with unknown id.
