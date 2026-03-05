import type { ChainDB } from '@reloaded/storage'

/**
 * Create table for engine
 * @param db - ChainDB Instance
 */
function createChainDBTables (db: ChainDB) {
// Initialize schema tables for in-memory database
  const sqlite = db.$client

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS nullifiers (
      nullifier TEXT PRIMARY KEY NOT NULL,
      txid TEXT NOT NULL,
      block_number TEXT NOT NULL,
      tree_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS nullifiers_block_number_idx ON nullifiers(block_number);
    CREATE INDEX IF NOT EXISTS nullifiers_tree_id_idx ON nullifiers(tree_id);

    CREATE TABLE IF NOT EXISTS merkle_nodes (
      tree_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      "index" TEXT NOT NULL,
      hash BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (tree_id, level, "index")
    );
    CREATE INDEX IF NOT EXISTS merkle_nodes_tree_level_idx ON merkle_nodes(tree_id, level);

    CREATE TABLE IF NOT EXISTS commitments (
      hash TEXT PRIMARY KEY NOT NULL,
      tree_id INTEGER NOT NULL,
      leaf_index TEXT NOT NULL,
      block_number TEXT NOT NULL,
      txid TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS commitments_tree_leaf_idx ON commitments(tree_id, leaf_index);
    CREATE INDEX IF NOT EXISTS commitments_block_number_idx ON commitments(block_number);

    CREATE TABLE IF NOT EXISTS merkle_roots (
      tree_id INTEGER NOT NULL,
      block_number TEXT NOT NULL,
      root BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (tree_id, block_number)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      chain_id INTEGER PRIMARY KEY NOT NULL,
      last_block TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

export { createChainDBTables }
