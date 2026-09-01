// PocketBase JS migration - enables vector search (vec1, the SQLite vector
// engine, on the custom build).
//
// The custom Go binary (see main.go) ships SQLite with the vec1 extension
// registered on every connection (github.com/ncruces/go-sqlite3/ext/vec1).
// This migration:
//  1. Proves the extension is actually loaded (by creating a vec1 table).
//  2. Creates a vec1 virtual table for ANN/KNN vector search.
//  3. Seeds a few vectors so /api/vec/search works out of the box.
//
// Runs only once (tracked in _migrations), and is a no-op with a clear error
// if someone runs it against the stock PocketBase binary.
//
// Note: vec1 tables are "shadow" virtual tables - they live alongside your
// data in the same SQLite file but are NOT PocketBase collections, so they
// are not exposed through the collections API. Use the /api/vec/* hooks for
// that (see pb_hooks/vec.pb.js).

migrate(
  (app) => {
    const db = app.db();

    // --- 1. Verify the extension is present --------------------------------
    // vec1_config() is only available when the vec1 extension is loaded, so
    // this also serves as the availability check.
    try {
      db.newQuery("SELECT vec1_config('nthread')").execute();
    } catch (e) {
      throw new Error(
        "vec1 is not available. This migration requires the custom build " +
          "(Dockerfile builds with vec1). If you are running the stock " +
          "pocketbase binary, switch to the custom build or delete this migration. " +
          "Underlying error: " + e.message
      );
    }
    console.log("==> vec1 ready");

    // --- 2. Create the vec1 virtual table ----------------------------------
    // vec1 = the SQLite equivalent of a pgvector table + HNSW index.
    db.newQuery("CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec1").execute();

    // --- 3. Seed a few vectors (via vec1_from_json) ------------------------
    const seed = [
      { vector: "[1, 1, 1]", label: "red-ish" },
      { vector: "[3, 3, 3]", label: "far from red" },
      { vector: "[1.1, 0.9, 1.05]", label: "almost red" },
    ];
    for (const item of seed) {
      db.newQuery(
        "INSERT INTO vec_items(rowid, vector) VALUES (NULL, vec1_from_json({:vector}))"
      )
        .bind({ vector: item.vector })
        .execute();
    }

    console.log("==> vec_items seeded with " + seed.length + " vectors");
  },
  (app) => {
    // Rollback: drop the virtual table if the migration is reverted.
    app
      .db()
      .newQuery("DROP TABLE IF EXISTS vec_items")
      .execute();
  }
);
