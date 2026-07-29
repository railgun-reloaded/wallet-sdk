import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Browser load-balances packaging check:
 * - pack this wallet-sdk checkout and its @railgun-reloaded dependency closure,
 * - install only those packed tarballs into a throwaway Vite fixture,
 * - run `vite build` and scan the built assets for Node reachability,
 * - serve `vite preview` and drive the page in headless Chrome.
 *
 * Run with: npm run fixture:browser:load-balances
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSourceDir = path.join(packageRoot, 'fixtures/browser-load-balances')
const installedScopeDir = path.join(packageRoot, 'node_modules/@railgun-reloaded')
const fallbackPackagesRoot = path.resolve(process.env.RAILGUN_PACKAGES_ROOT ?? path.join(packageRoot, '..'))
const PREVIEW_PORT = Number(process.env.RAILGUN_BROWSER_FIXTURE_PORT ?? 43123)
const DIRECT_FIXTURE_PACKAGES = [
  '@railgun-reloaded/wallet-sdk',
  '@railgun-reloaded/storage',
  '@railgun-reloaded/scanner'
]

const FORBIDDEN_BUNDLE_PATTERNS = [
  {
    label: 'node: built-in import',
    pattern: /\b(?:from\s*['"]node:|import\s*\(\s*['"]node:|import\s*['"]node:|require\s*\(\s*['"]node:)/
  },
  {
    label: 'unprefixed Node built-in import',
    pattern: /\b(?:from\s*['"](?:fs|path|zlib)['"]|import\s*\(\s*['"](?:fs|path|zlib)['"]|import\s*['"](?:fs|path|zlib)['"]|require\s*\(\s*['"](?:fs|path|zlib)['"])/
  },
  { label: 'better-sqlite3', pattern: /better-sqlite3/ },
  { label: 'Buffer global usage', pattern: /\bBuffer\b/ },
  { label: '@railgun-reloaded/storage/node', pattern: /@railgun-reloaded\/storage\/node/ },
  { label: '@railgun-reloaded/wallet-sdk/node', pattern: /@railgun-reloaded\/wallet-sdk\/node/ }
]

// drizzle-orm's sqlite-core `blob({ mode: 'bigint' | 'json' })` column
// builders (drizzle-orm/sqlite-core/columns/blob.js) reference the bare
// Buffer global in mapFromDriverValue/mapToDriverValue. Neither builder is
// ever invoked by @railgun-reloaded/storage's schema (grep the schema for
// `blob(` to confirm), so the reference is dead code that a bundler cannot
// tree-shake because drizzle's sqlite-proxy driver imports the sqlite-core
// barrel internally. This allowlist covers only those four known call
// sites -- any other Buffer usage anywhere in the bundle still fails the
// check above.
const KNOWN_DEAD_BUFFER_CALL_SITES = [
  /BigInt\(\s*Buffer\.isBuffer\(/,
  /Buffer\.from\(\s*\w+\.toString\(\)\s*\)/,
  /JSON\.parse\(\s*Buffer\.isBuffer\(/,
  /Buffer\.from\(\s*JSON\.stringify\(/
]

/**
 * Remove drizzle-orm's known-dead blob.js Buffer call sites from bundle
 * source before scanning for forbidden patterns, so this specific,
 * unreachable third-party reference doesn't fail the check while any
 * other Buffer usage still does.
 * @param {string} source - Raw bundle source.
 * @returns {string} Source with the known dead call sites removed.
 */
function stripKnownDeadBufferCallSites (source) {
  return KNOWN_DEAD_BUFFER_CALL_SITES.reduce(
    (text, pattern) => text.replace(pattern, ''),
    source
  )
}

/**
 * Parse one package.json.
 * @param {string} packageDir - Directory containing package.json.
 * @returns {Record<string, unknown>} Parsed package manifest.
 */
function readPackageJson (packageDir) {
  return JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
}

/**
 * Discover installed @railgun-reloaded package roots.
 * @param {string} scopeDir - node_modules/@railgun-reloaded directory.
 * @returns {Map<string, string>} Package name to package root.
 */
function discoverInstalledPackageRoots (scopeDir) {
  const packages = new Map()
  if (!existsSync(scopeDir)) {
    return packages
  }
  for (const entry of readdirSync(scopeDir)) {
    const packageDir = path.join(scopeDir, entry)
    const packageJsonPath = path.join(packageDir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      continue
    }
    const manifest = readPackageJson(packageDir)
    if (typeof manifest.name === 'string') {
      packages.set(manifest.name, packageDir)
    }
  }
  return packages
}

/**
 * Discover sibling @railgun-reloaded package roots.
 * @param {string} packagesRoot - Directory containing sibling package checkouts.
 * @returns {Map<string, string>} Package name to package root.
 */
function discoverSiblingPackageRoots (packagesRoot) {
  const packages = new Map()
  if (!existsSync(packagesRoot)) {
    return packages
  }
  for (const entry of readdirSync(packagesRoot)) {
    const packageDir = path.join(packagesRoot, entry)
    const packageJsonPath = path.join(packageDir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      continue
    }
    const manifest = readPackageJson(packageDir)
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@railgun-reloaded/')) {
      packages.set(manifest.name, packageDir)
    }
  }
  return packages
}

const installedPackages = discoverInstalledPackageRoots(installedScopeDir)
const siblingPackages = discoverSiblingPackageRoots(fallbackPackagesRoot)

/**
 * Resolve a package root for tarball packing.
 * @param {string} packageName - Package name.
 * @returns {string | undefined} Resolved package root.
 */
function resolvePackageRoot (packageName) {
  if (packageName === '@railgun-reloaded/wallet-sdk') {
    return packageRoot
  }
  return installedPackages.get(packageName) ?? siblingPackages.get(packageName)
}

/**
 * Return @railgun-reloaded dependencies declared by a package.
 * @param {Record<string, unknown>} manifest - Package manifest.
 * @returns {string[]} Runtime package dependency names.
 */
function railgunDependencies (manifest) {
  const dependencies = manifest.dependencies
  if (dependencies === undefined || dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return []
  }
  return Object.keys(dependencies)
    .filter(name => name.startsWith('@railgun-reloaded/'))
}

/**
 * Collect the @railgun-reloaded dependency closure used by the fixture.
 * @returns {Map<string, string>} Package names to resolved roots.
 */
function collectRailgunPackageClosure () {
  const queue = [...DIRECT_FIXTURE_PACKAGES]
  const packages = new Map()
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packages.has(packageName)) {
      continue
    }
    const packageDir = resolvePackageRoot(packageName)
    if (packageDir === undefined) {
      throw new Error(`Cannot pack ${packageName}: install it first or set RAILGUN_PACKAGES_ROOT to sibling checkouts`)
    }
    packages.set(packageName, packageDir)
    for (const dependencyName of railgunDependencies(readPackageJson(packageDir))) {
      queue.push(dependencyName)
    }
  }
  return packages
}

/**
 * Run a command, streaming stdio, and fail on a non-zero exit.
 * @param {string} command - Executable name.
 * @param {string[]} args - Command arguments.
 * @param {string} cwd - Working directory.
 * @returns {Promise<void>} Resolves when the command succeeds.
 */
function run (command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

/**
 * Pack a package into a tarball without running package lifecycle scripts.
 * The wallet-sdk package is built explicitly before this check starts.
 * @param {string} packageName - Package being packed.
 * @param {string} packageDir - Package root.
 * @param {string} packDir - Destination directory for tarballs.
 * @returns {Promise<string>} Absolute tarball path.
 */
async function packPackage (packageName, packageDir, packDir) {
  const before = new Set(readdirSync(packDir))
  console.log(`Packing ${packageName} from ${path.relative(packageRoot, packageDir) || '.'}...`)
  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], packageDir)
  const packed = readdirSync(packDir)
    .filter(entry => entry.endsWith('.tgz') && !before.has(entry))
  if (packed.length !== 1) {
    throw new Error(`Expected one tarball while packing ${packageName}, found ${packed.length}`)
  }
  return path.join(packDir, packed[0])
}

/**
 * Copy a directory recursively.
 * @param {string} from - Source path.
 * @param {string} to - Destination path.
 */
function copyDirectory (from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = path.join(from, entry)
    const target = path.join(to, entry)
    const stat = statSync(source)
    if (stat.isDirectory()) {
      copyDirectory(source, target)
    } else if (stat.isFile()) {
      writeFileSync(target, readFileSync(source))
    }
  }
}

/**
 * Write the fixture package manifest with packed tarball dependencies.
 * @param {string} fixtureDir - Temporary fixture directory.
 * @param {Map<string, string>} tarballs - Package names to tarball paths.
 */
function writePackedFixturePackageJson (fixtureDir, tarballs) {
  const manifest = readPackageJson(fixtureDir)
  const packedDependencies = Object.fromEntries(
    [...tarballs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, tarball]) => [
        packageName,
        `file:${path.relative(fixtureDir, tarball)}`
      ])
  )
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    ...packedDependencies
  }
  manifest.overrides = {
    ...(manifest.overrides ?? {}),
    ...Object.fromEntries(Object.keys(packedDependencies).map(packageName => [
      packageName,
      `$${packageName}`
    ]))
  }
  writeFileSync(path.join(fixtureDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Walk a directory and return every JS asset path.
 * @param {string} dir - Directory to scan.
 * @returns {string[]} JavaScript asset files.
 */
function listJavaScriptAssets (dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry)
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      files.push(...listJavaScriptAssets(absolute))
    } else if (stat.isFile() && absolute.endsWith('.js')) {
      files.push(absolute)
    }
  }
  return files
}

/**
 * Assert the production bundle did not pull forbidden Node-only surfaces.
 * @param {string} fixtureDir - Fixture root containing dist.
 */
function assertBrowserBundleIsClean (fixtureDir) {
  const assets = listJavaScriptAssets(path.join(fixtureDir, 'dist'))
  if (assets.length === 0) {
    throw new Error('Bundle check found no JavaScript assets in fixture dist')
  }
  for (const asset of assets) {
    const source = readFileSync(asset, 'utf8')
    const sourceWithoutKnownDeadBuffer = stripKnownDeadBufferCallSites(source)
    for (const forbidden of FORBIDDEN_BUNDLE_PATTERNS) {
      const scanned = forbidden.label === 'Buffer global usage' ? sourceWithoutKnownDeadBuffer : source
      if (forbidden.pattern.test(scanned)) {
        throw new Error(`Browser bundle contains forbidden ${forbidden.label} in ${path.relative(fixtureDir, asset)}`)
      }
    }
  }
}

/**
 * Wait until a TCP port accepts connections.
 * @param {number} port - Port to poll.
 * @param {number} timeoutMs - Give up after this many milliseconds.
 * @returns {Promise<void>} Resolves when the port is reachable.
 */
async function waitForPort (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (connected) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`vite preview did not start listening on port ${port}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/**
 * Import playwright-core from the generated fixture install.
 *
 * playwright-core's CJS entry reassigns `module.exports` to a class
 * instance at runtime (`module.exports = require(...).inprocess.playwright`),
 * a pattern Node's CJS-named-exports synthesizer cannot statically detect.
 * A dynamic `import()` of that file therefore only yields a `default`
 * export with no named `chromium`/`firefox`/etc. -- fall back to it.
 * @param {string} fixtureDir - Fixture root.
 * @returns {Promise<import('playwright-core')>} Playwright module.
 */
async function importPlaywright (fixtureDir) {
  const modulePath = path.join(fixtureDir, 'node_modules/playwright-core/index.js')
  const imported = await import(pathToFileURL(modulePath).href)
  return imported.chromium === undefined ? imported.default : imported
}

/**
 * Launch Chromium through playwright-core.
 * @param {import('playwright-core').ChromiumBrowserType} chromium - Playwright Chromium launcher.
 * @returns {Promise<import('playwright-core').Browser>} Browser instance.
 */
async function launchBrowser (chromium) {
  const baseOptions = {
    headless: true,
    args: ['--no-sandbox']
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return chromium.launch({
      ...baseOptions,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    })
  }
  return chromium.launch({
    ...baseOptions,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL ?? 'chrome'
  })
}

/**
 * Read the fixture's browser report from a page.
 * @param {import('playwright-core').Page} page - Browser page.
 * @returns {Promise<Record<string, unknown>>} Fixture report.
 */
async function readFixtureReport (page) {
  await page.waitForFunction('window.__railgunBrowserFixture?.done === true', undefined, { timeout: 300_000 })
  const report = await page.evaluate('window.__railgunBrowserFixture.report')
  if (report === undefined || report === null || typeof report !== 'object') {
    throw new Error('Fixture did not expose a report object')
  }
  if (!report.ok) {
    throw new Error(`Fixture failed:\n${report.error ?? 'unknown error'}`)
  }
  return report
}

/**
 * Drive the previewed fixture through clean and persisted-storage passes.
 * @param {string} fixtureDir - Temporary fixture root.
 * @returns {Promise<void>}
 */
async function runBrowserFixture (fixtureDir) {
  const { chromium } = await importPlaywright(fixtureDir)
  let browser
  try {
    browser = await launchBrowser(chromium)
  } catch (error) {
    throw new Error(
      `Failed to launch Chrome for the browser fixture. Install Google Chrome or set PLAYWRIGHT_CHROMIUM_EXECUTABLE. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }

  try {
    const page = await browser.newPage()
    const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}/`

    console.log('Running fixture from clean storage...')
    await page.goto(`${baseUrl}?reset=1`)
    const cleanReport = await readFixtureReport(page)
    if (cleanReport.cleanStart !== true) {
      throw new Error('Expected first fixture pass to start from clean storage')
    }

    console.log('Reloading fixture to verify persisted cursor...')
    await page.goto(baseUrl)
    const persistedReport = await readFixtureReport(page)
    if (persistedReport.resumedFromStoredCursor !== true) {
      throw new Error(`Expected persisted fixture pass to resume from stored cursor, got ${JSON.stringify(persistedReport)}`)
    }

    console.log('Fixture passed:')
    for (const line of cleanReport.steps ?? []) {
      console.log(`  - ${line}`)
    }
    for (const line of persistedReport.steps ?? []) {
      console.log(`  - reload: ${line}`)
    }
  } finally {
    await browser.close()
  }
}

const packDir = path.join(tmpdir(), `wallet-sdk-browser-packs-${process.pid}`)
const fixtureDir = path.join(tmpdir(), `wallet-sdk-browser-load-balances-${process.pid}`)
let preview
let succeeded = false
try {
  rmSync(packDir, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
  mkdirSync(packDir, { recursive: true })

  console.log('Building wallet-sdk before packing...')
  await run('npm', ['run', 'build'], packageRoot)

  const packageRoots = collectRailgunPackageClosure()
  const tarballs = new Map()
  for (const [packageName, packageDir] of [...packageRoots.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    tarballs.set(packageName, await packPackage(packageName, packageDir, packDir))
  }

  copyDirectory(fixtureSourceDir, fixtureDir)
  writePackedFixturePackageJson(fixtureDir, tarballs)

  console.log('Installing packed fixture dependencies...')
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], fixtureDir)

  console.log('Building fixture with default Vite browser config...')
  await run('npm', ['run', 'build'], fixtureDir)
  assertBrowserBundleIsClean(fixtureDir)

  console.log('Serving fixture with vite preview...')
  preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: fixtureDir,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  await waitForPort(PREVIEW_PORT, 30_000)
  await runBrowserFixture(fixtureDir)
  succeeded = true
} finally {
  preview?.kill()
  if (succeeded) {
    rmSync(packDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
  } else {
    console.error(`Preserved failed fixture workspace at ${fixtureDir}`)
    console.error(`Preserved packed tarballs at ${packDir}`)
  }
}
