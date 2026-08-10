import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as browserEntry from '../src/browser/index.js'
import * as rootEntry from '../src/index.js'
import * as nodeEntry from '../src/node/index.js'
import * as snapshotBootstrap from '../src/snapshot-bootstrap/index.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BUILTINS = new Set(builtinModules)
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
const DECLARED_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}/g
const PORTABLE_ENTRIES = ['index.d.ts', 'browser/index.d.ts']

type DeclarationGraph = {
  files: string[]
  packages: string[]
  unresolved: string[]
}

/**
 * Decide whether a package specifier resolves only under Node.
 * @param specifier - Bare import specifier.
 * @returns True for Node built-ins and for `/node` subpath exports.
 */
function isNodeOnly (specifier: string): boolean {
  return specifier.startsWith('node:') ||
    BUILTINS.has(specifier) ||
    specifier.endsWith('/node')
}

/**
 * Sorted runtime export names of a module namespace. Type-only exports erase
 * at runtime and never appear here.
 * @param entry - Imported module namespace object.
 * @returns Export names in sorted order.
 */
function namesOf (entry: object): string[] {
  return Object.keys(entry).sort()
}

/**
 * Declared export names of an emitted declaration file. This covers values and
 * type-only exports together. A runtime namespace object omits types, so this
 * is the only view of the complete published surface.
 * @param relativePath - Declaration file path, relative to `src`.
 * @returns Exported names in sorted order.
 */
function declaredNames (relativePath: string): string[] {
  const source = readFileSync(resolve(SRC, relativePath), 'utf8')
  const names = new Set<string>()

  for (const [, group] of source.matchAll(DECLARED_EXPORT)) {
    for (const name of (group ?? '').split(',')) {
      const trimmed = name.trim()

      if (trimmed !== '') {
        names.add(trimmed)
      }
    }
  }

  return [...names].sort()
}

/**
 * Walk the transitive declaration import graph of an entry point. Declarations
 * carry the published type surface, so a Node-only package that appears here
 * leaks into consumers even when it never reaches the runtime bundle.
 * @param entry - Declaration file path, relative to `src`.
 * @returns Files reached, bare packages imported, and unresolved targets.
 */
function walkDeclarations (entry: string): DeclarationGraph {
  const files = new Set<string>()
  const packages = new Set<string>()
  const unresolved = new Set<string>()
  const queue = [resolve(SRC, entry)]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) {
      continue
    }
    files.add(file)

    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (specifier === undefined) {
        continue
      }

      if (!specifier.startsWith('.')) {
        packages.add(specifier)
        continue
      }

      const target = join(dirname(file), specifier.replace(/\.js$/, '.d.ts'))
      if (existsSync(target)) {
        queue.push(target)
      } else {
        unresolved.add(relative(SRC, target))
      }
    }
  }

  return {
    files: [...files].map((file) => relative(SRC, file)).sort(),
    packages: [...packages].sort(),
    unresolved: [...unresolved].sort()
  }
}

test('root and browser entries expose an identical runtime surface', () => {
  assert.deepEqual(namesOf(rootEntry), namesOf(browserEntry))
})

test('node entry adds only snapshot bootstrap values', () => {
  const portable = new Set(namesOf(browserEntry))
  const allowed = new Set(namesOf(snapshotBootstrap))
  const extra = namesOf(nodeEntry).filter((name) => !portable.has(name))

  assert.deepEqual(extra.filter((name) => !allowed.has(name)), [])
})

test('root and browser entries declare an identical surface', () => {
  assert.deepEqual(declaredNames('index.d.ts'), declaredNames('browser/index.d.ts'))
})

test('node entry declares only snapshot bootstrap and event names beyond the portable surface', () => {
  const portable = new Set(declaredNames('browser/index.d.ts'))
  const allowed = new Set([
    ...declaredNames('snapshot-bootstrap/index.d.ts'),
    ...declaredNames('events/index.d.ts')
  ])
  const extra = declaredNames('node/index.d.ts').filter((name) => !portable.has(name))

  assert.deepEqual(extra.filter((name) => !allowed.has(name)), [])
})

test('the declared surface covers the type-only exports', () => {
  const declared = new Set(declaredNames('browser/index.d.ts'))
  const values = namesOf(browserEntry)

  for (const name of values) {
    assert.ok(declared.has(name), `${name} is a runtime value missing from the declared surface`)
  }

  assert.ok(
    declared.size > values.length,
    'the parser finds no type-only exports, so the declared checks prove nothing'
  )
})

test('portable entries export nothing the node entry lacks', () => {
  const node = new Set(namesOf(nodeEntry))

  assert.deepEqual(namesOf(browserEntry).filter((name) => !node.has(name)), [])
  assert.deepEqual(namesOf(rootEntry).filter((name) => !node.has(name)), [])
})

test('snapshot bootstrap values stay off the portable entries', () => {
  const portable = new Set([...namesOf(rootEntry), ...namesOf(browserEntry)])

  for (const name of namesOf(snapshotBootstrap)) {
    assert.ok(!portable.has(name), `${name} reaches the filesystem and must stay Node-only`)
  }
})

test('generateWalletId is reachable from every entry', () => {
  assert.equal(typeof rootEntry.generateWalletId, 'function')
  assert.equal(typeof browserEntry.generateWalletId, 'function')
  assert.equal(typeof nodeEntry.generateWalletId, 'function')
})

test('portable declaration graphs resolve completely', () => {
  for (const entry of PORTABLE_ENTRIES) {
    assert.deepEqual(walkDeclarations(entry).unresolved, [], entry)
  }
})

test('portable declaration graphs reach no node-only package', () => {
  for (const entry of PORTABLE_ENTRIES) {
    const reached = walkDeclarations(entry).packages.filter(isNodeOnly)

    assert.deepEqual(reached, [], `${entry} publishes types that need ${reached.join(', ')}`)
  }
})

test('the node declaration graph does reach a node-only package', () => {
  const reached = walkDeclarations('node/index.d.ts').packages.filter(isNodeOnly)

  assert.ok(reached.length > 0, 'the walk detects nothing, so the portable check proves nothing')
})

test('portable declaration graphs never reach the events module', () => {
  for (const entry of PORTABLE_ENTRIES) {
    const events = walkDeclarations(entry).files.filter((file) => file.startsWith('events/'))

    assert.deepEqual(events, [], `${entry} documents an event API the portable client lacks`)
  }
})
