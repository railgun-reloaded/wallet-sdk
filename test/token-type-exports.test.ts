import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TokenType as BrowserTokenType } from '../src/browser/index.js'
import { TokenType as RootTokenType } from '../src/index.js'
import { TokenType as NodeTokenType } from '../src/node/index.js'

test('TokenType is exported from every public entry point', () => {
  assert.equal(RootTokenType.ERC721, NodeTokenType.ERC721)
  assert.equal(RootTokenType.ERC721, BrowserTokenType.ERC721)
})
