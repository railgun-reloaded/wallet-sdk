import { SourceAggregator } from '@railgun-reloaded/scanner/src/sources/source-aggregator.js'
import { SubsquidProvider } from '@railgun-reloaded/scanner/src/sources/subsquid/provider.js'
import {
  chainDatabaseName,
  closeChainDB,
  closeWalletDB,
  createChainDB,
  createChainStorage,
  createWalletDB,
  createWalletStorage,
  deleteDatabase
} from '@railgun-reloaded/storage/browser'
import {
  NETWORK_CONFIG,
  NetworkName,
  RailgunClient,
  WalletBalanceBucket
} from '@railgun-reloaded/wallet-sdk'

import './styles.css'

const NETWORK = NetworkName.EthereumSepolia
const NETWORK_CONFIG_ENTRY = NETWORK_CONFIG[NETWORK]
const CHAIN_ID = NETWORK_CONFIG_ENTRY.chainID
const RAILGUN_VERSION = 0
const START_BLOCK = NETWORK_CONFIG_ENTRY.deploymentBlock
const END_BLOCK = 5_970_612n
const SUBSQUID_URL = 'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql'
const MNEMONIC = 'test test test test test test test test test test test junk'
const EXPECTED_WALLET_ID = 'bee63912e0e4cfa6830ebc8342d3efa9aa1336548c77bf4336c54c17409f2990'
const ENCRYPTION_KEY = Uint8Array.from({ length: 32 }, (_, index) => index)
const WALLET_DB_NAME = 'wallet-sdk-browser-load-balances-wallet'
const CHAIN_DB_NAME = `${chainDatabaseName({ chain: CHAIN_ID, railgunVersion: RAILGUN_VERSION })}-browser-load-balances`
const EXPECTED_NOTES = 1
const EXPECTED_TOKEN = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
const EXPECTED_BALANCE = '20000000000000000'
const EXPECTED_SPENDABLE = []
const EXPECTED_BUCKETS = {
  [WalletBalanceBucket.Spendable]: [],
  [WalletBalanceBucket.ShieldPending]: [],
  [WalletBalanceBucket.ShieldBlocked]: [],
  [WalletBalanceBucket.ProofSubmitted]: [],
  [WalletBalanceBucket.MissingInternalPOI]: [],
  [WalletBalanceBucket.MissingExternalPOI]: [
    { token: EXPECTED_TOKEN, balance: EXPECTED_BALANCE }
  ],
  [WalletBalanceBucket.Spent]: []
}

const elements = {
  status: document.querySelector('#status'),
  range: document.querySelector('#range'),
  chainCursor: document.querySelector('#chain-cursor'),
  walletCursor: document.querySelector('#wallet-cursor'),
  notes: document.querySelector('#notes'),
  spendable: document.querySelector('#spendable'),
  buckets: document.querySelector('#buckets'),
  log: document.querySelector('#log'),
  reset: document.querySelector('#reset-storage')
}

const steps = []

/**
 * Set the current run status.
 * @param {string} message - Status text.
 */
function setStatus (message) {
  elements.status.textContent = message
}

/**
 * Append one run-log step to the UI and report.
 * @param {string} message - Step text.
 */
function step (message) {
  steps.push(message)
  const item = document.createElement('li')
  item.textContent = message
  elements.log.append(item)
}

/**
 * Convert bigint values to decimal strings.
 * @param {bigint | undefined | null} value - Bigint-like value.
 * @returns {string | null} Decimal string, or null for absent values.
 */
function bigintString (value) {
  return value === undefined || value === null ? null : value.toString()
}

/**
 * Convert public token balance rows to JSON-safe rows.
 * @param {{ token: string, balance: bigint }[]} balances - SDK balances.
 * @returns {{ token: string, balance: string }[]} Serializable balances.
 */
function serializeBalances (balances) {
  return balances.map(balance => ({
    token: balance.token,
    balance: balance.balance.toString()
  }))
}

/**
 * Convert bucket balance rows to JSON-safe rows.
 * @param {Record<string, { token: string, balance: bigint }[]>} buckets - SDK bucket map.
 * @returns {Record<string, { token: string, balance: string }[]>} Serializable bucket map.
 */
function serializeBuckets (buckets) {
  return Object.fromEntries(
    Object.values(WalletBalanceBucket).map(bucket => [
      bucket,
      serializeBalances(buckets[bucket] ?? [])
    ])
  )
}

/**
 * Render a balance list.
 * @param {Element} target - Container to render into.
 * @param {{ token: string, balance: string }[]} balances - Serializable balances.
 */
function renderBalanceRows (target, balances) {
  target.replaceChildren()
  if (balances.length === 0) {
    const row = document.createElement('div')
    row.className = 'empty'
    row.textContent = '0'
    target.append(row)
    return
  }

  for (const balance of balances) {
    const row = document.createElement('div')
    row.className = 'balance-row'
    const token = document.createElement('span')
    token.textContent = balance.token
    const amount = document.createElement('strong')
    amount.textContent = balance.balance
    row.append(token, amount)
    target.append(row)
  }
}

/**
 * Render every PPOI bucket.
 * @param {Record<string, { token: string, balance: string }[]>} buckets - Serializable bucket balances.
 */
function renderBuckets (buckets) {
  elements.buckets.replaceChildren()
  for (const bucket of Object.values(WalletBalanceBucket)) {
    const group = document.createElement('article')
    group.className = 'bucket'
    const title = document.createElement('h3')
    title.textContent = bucket
    const body = document.createElement('div')
    body.className = 'rows'
    renderBalanceRows(body, buckets[bucket] ?? [])
    group.append(title, body)
    elements.buckets.append(group)
  }
}

/**
 * Make sure the deterministic test wallet exists.
 * @param {RailgunClient} client - Portable browser client.
 * @returns {Promise<{ walletId: string, name?: string | undefined }>} Wallet info.
 */
async function ensureWallet (client) {
  const existing = (await client.listWallets())
    .find(wallet => wallet.walletId === EXPECTED_WALLET_ID)
  if (existing !== undefined) {
    return existing
  }
  return client.createWallet({
    mnemonic: MNEMONIC,
    encryptionKey: ENCRYPTION_KEY,
    name: 'browser fixture'
  })
}

/**
 * Compare serialized balances with the expected fixture state.
 * @param {{ token: string, balance: string }[]} spendable - Actual spendable balances.
 * @param {Record<string, { token: string, balance: string }[]>} buckets - Actual bucket balances.
 * @param {number} notes - Decrypted note count.
 */
function assertExpectedBalances (spendable, buckets, notes) {
  const actualSpendable = JSON.stringify(spendable)
  const expectedSpendable = JSON.stringify(EXPECTED_SPENDABLE)
  if (actualSpendable !== expectedSpendable) {
    throw new Error(`Expected spendable balance ${expectedSpendable}, got ${actualSpendable}`)
  }
  const actual = JSON.stringify(buckets)
  const expected = JSON.stringify(EXPECTED_BUCKETS)
  if (actual !== expected) {
    throw new Error(`Expected PPOI buckets ${expected}, got ${actual}`)
  }
  if (notes !== EXPECTED_NOTES) {
    throw new Error(`Expected ${EXPECTED_NOTES} decrypted note, got ${notes}`)
  }
}

/**
 * Reflect sync progress in the status strip.
 * @param {{ phase: string, currentBlock: bigint }} progress - SDK sync progress.
 */
function updateProgress (progress) {
  setStatus(`${progress.phase} ${progress.currentBlock.toString()}`)
}

/**
 * Run one end-to-end browser sync pass.
 * @param {{ reset: boolean }} options - Run options.
 * @returns {Promise<Record<string, unknown>>} Serializable run report.
 */
async function runFixture (options) {
  steps.length = 0
  elements.log.replaceChildren()
  setStatus('Opening storage')
  elements.range.textContent = `${START_BLOCK.toString()}-${END_BLOCK.toString()}`

  if (options.reset) {
    await deleteDatabase(CHAIN_DB_NAME)
    await deleteDatabase(WALLET_DB_NAME)
    step('storage reset')
  }

  const chainDB = await createChainDB({ name: CHAIN_DB_NAME, waitForLock: true })
  const walletDB = await createWalletDB({ name: WALLET_DB_NAME, waitForLock: true })

  try {
    const chainStorage = createChainStorage(chainDB)
    const walletStorage = createWalletStorage(walletDB)
    const initialChainCursor = (await chainStorage.getSyncState(CHAIN_ID))?.lastBlockHeight
    const cleanStart = initialChainCursor === undefined
    const resumedFromStoredCursor = initialChainCursor !== undefined && initialChainCursor >= END_BLOCK
    elements.chainCursor.textContent = bigintString(initialChainCursor) ?? 'none'
    step(cleanStart ? 'opened clean chain storage' : `opened chain storage at ${initialChainCursor.toString()}`)

    const client = await RailgunClient.create({ chainStorage, walletStorage })
    await client.initialize()
    const wallet = await ensureWallet(client)
    const walletContext = await client.loadWallet(wallet.walletId, ENCRYPTION_KEY)
    const initialWalletCursor = (await walletStorage.getScanState(wallet.walletId, CHAIN_ID))?.lastScannedBlock
    const decryptFromBlock = initialWalletCursor !== undefined ? initialWalletCursor + 1n : START_BLOCK
    step(`loaded wallet ${walletContext.railgunAddress.slice(0, 18)}...`)

    setStatus('Scanning bounded Sepolia range')
    const dataSource = new SourceAggregator([
      new SubsquidProvider(SUBSQUID_URL)
    ])
    const summary = await client.sync(wallet.walletId, ENCRYPTION_KEY, {
      network: NETWORK,
      dataSource,
      endBlock: END_BLOCK,
      fromBlock: decryptFromBlock,
      refreshPoi: false,
      onProgress: updateProgress
    })
    await client.close()
    step(`scan cursor ${bigintString(summary.scan.lastBlock) ?? 'none'}`)
    step(`decrypt added ${summary.decrypt.notesAdded} spent ${summary.decrypt.notesSpent}`)

    const finalChainCursor = (await chainStorage.getSyncState(CHAIN_ID))?.lastBlockHeight
    const walletCursor = (await walletStorage.getScanState(wallet.walletId, CHAIN_ID))?.lastScannedBlock
    const spendable = serializeBalances(await client.getBalances(wallet.walletId, CHAIN_ID))
    const buckets = serializeBuckets(await client.getBalancesByBucket(wallet.walletId, CHAIN_ID))
    const notes = await client.getNotes(wallet.walletId, CHAIN_ID)

    if (finalChainCursor !== END_BLOCK) {
      throw new Error(`Expected chain cursor ${END_BLOCK.toString()}, got ${bigintString(finalChainCursor) ?? 'none'}`)
    }
    if (walletCursor !== END_BLOCK) {
      throw new Error(`Expected wallet cursor ${END_BLOCK.toString()}, got ${bigintString(walletCursor) ?? 'none'}`)
    }
    assertExpectedBalances(spendable, buckets, notes.length)

    elements.chainCursor.textContent = finalChainCursor.toString()
    elements.walletCursor.textContent = walletCursor.toString()
    elements.notes.textContent = notes.length.toString()
    renderBalanceRows(elements.spendable, spendable)
    renderBuckets(buckets)
    setStatus(resumedFromStoredCursor ? 'Resumed from storage' : 'Synced from clean storage')

    return {
      ok: true,
      cleanStart,
      resumedFromStoredCursor,
      range: {
        startBlock: START_BLOCK.toString(),
        endBlock: END_BLOCK.toString()
      },
      walletId: wallet.walletId,
      railgunAddress: walletContext.railgunAddress,
      initialChainCursor: bigintString(initialChainCursor),
      finalChainCursor: bigintString(finalChainCursor),
      walletCursor: bigintString(walletCursor),
      spendable,
      buckets,
      notes: notes.length,
      sync: {
        scanLastBlock: bigintString(summary.scan.lastBlock),
        decrypt: {
          fromBlock: summary.decrypt.fromBlock.toString(),
          toBlock: summary.decrypt.toBlock.toString(),
          notesAdded: summary.decrypt.notesAdded,
          notesSpent: summary.decrypt.notesSpent
        }
      },
      steps: [...steps]
    }
  } finally {
    await closeChainDB(chainDB)
    await closeWalletDB(walletDB)
  }
}

/**
 * Run and expose a report for headless CI.
 * @param {{ reset: boolean }} options - Run options.
 */
async function boot (options) {
  window.__railgunBrowserFixture = { done: false, report: undefined }
  try {
    const report = await runFixture(options)
    window.__railgunBrowserFixture = { done: true, report }
  } catch (error) {
    const report = {
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      steps: [...steps]
    }
    window.__railgunBrowserFixture = { done: true, report }
    setStatus('Failed')
    throw error
  }
}

/**
 * Surface async boot failures in the browser console.
 * @param {unknown} error - Rejected boot error.
 */
function handleBootError (error) {
  console.error(error)
}

/**
 * Reset persistent fixture storage and run again.
 */
function resetAndRun () {
  boot({ reset: true }).catch(handleBootError)
}

elements.reset.addEventListener('click', resetAndRun)

const params = new URLSearchParams(window.location.search)
boot({ reset: params.get('reset') === '1' }).catch(handleBootError)
