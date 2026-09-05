// PocketBase JS migration - enables full-text search via SQLite FTS5.
//
// FTS5 is SQLite's built-in full-text search engine. It provides:
// - BM25 ranking (relevance scoring)
// - Prefix queries, phrase queries, boolean operators
// - Highlight/snippets for search results
// - Much faster than LIKE '%term%' on large text fields
//
// This migration creates an FTS5 virtual table that mirrors record content
// from any collection. Records are synced automatically via pb_hooks/fts.pb.js.
//
// The FTS table stores:
//   - collection: which collection the record belongs to
//   - record_id: the PocketBase record ID
//   - title: primary title/name field (weighted higher in ranking)
//   - content: main text content
//   - metadata: additional searchable fields (JSON)
//
// Config: set PB_FTS_DISABLED=1 to skip this migration's effects.

migrate(
  (app) => {
    const db = app.db();

    try {
      // Check if FTS5 is available (it's included in the ncruces SQLite driver)
      db.newQuery("SELECT fts5('test')").execute();
    } catch (e) {
      throw new Error(
        "FTS5 is not available. This migration requires the custom build " +
          "with the ncruces/go-sqlite3 driver. Underlying error: " + e.message
      );
    }

    // Drop existing table if present (allows schema changes)
    db.newQuery("DROP TABLE IF EXISTS fts_records").execute();

    // Create FTS5 virtual table with BM25 ranking support.
    // collection and record_id are UNINDEXED (exact match only),
    // title and content are full-text indexed.
    db.newQuery(`CREATE VIRTUAL TABLE fts_records USING fts5(
      collection UNINDEXED,
      record_id UNINDEXED,
      title,
      content,
      tokenize='unicode61 remove_diacritics 2'
    )`).execute();

    console.log("==> FTS5 full-text search enabled (fts_records table created)");
  },
  (app) => {
    // Rollback: drop the FTS5 table
    app.db().newQuery("DROP TABLE IF EXISTS fts_records").execute();
  }
);
