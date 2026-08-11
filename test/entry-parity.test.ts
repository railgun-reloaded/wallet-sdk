import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BUILTINS = new Set(builtinModules)
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
const TRIPLE_SLASH_TYPES = /\/\/\/\s*<reference\s+types=["']([^"']+)["']/g
const PORTABLE_ENTRIES = ['index.d.ts', 'browser/index.d.ts']

/**
 * Packages that resolve only under Node but that no naming rule catches.
 * `node` is the name a `/// <reference types="node" />` directive carries, and
 * `better-sqlite3` backs the Node storage driver.
 */
const NODE_ONLY_PACKAGES = new Set([
  'better-sqlite3',
  'drizzle-orm/better-sqlite3',
  'node'
])

type DeclarationGraph = {
  files: string[]
  packages: string[]
  unresolved: string[]
}

/**
 * Decide whether a package specifier resolves only under Node.
 * @param specifier - Bare import specifier, or a referenced types package.
 * @returns True for Node built-ins, `/node` subpaths, and known Node packages.
 */
function isNodeOnly (specifier: string): boolean {
  return specifier.startsWith('node:') ||
    BUILTINS.has(specifier) ||
    NODE_ONLY_PACKAGES.has(specifier) ||
    specifier.endsWith('/node') ||
    specifier.includes('/node/')
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
    const file = queue.pop()

    if (file === undefined || files.has(file)) {
      continue
    }
    files.add(file)

    const source = readFileSync(file, 'utf8')

    for (const [, referenced] of source.matchAll(TRIPLE_SLASH_TYPES)) {
      if (referenced !== undefined) {
        packages.add(referenced)
      }
    }

    for (const [, specifier] of source.matchAll(SPECIFIER)) {
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
