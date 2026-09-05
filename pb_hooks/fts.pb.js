// FTS5 auto-sync hook - keeps the full-text search index in sync with records.
//
// This hook automatically indexes records into the fts_records FTS5 virtual table
// whenever they are created, updated, or deleted. It extracts searchable text
// from configured fields on each collection.
//
// Configuration:
//   - Set PB_FTS_DISABLED=true to disable indexing
//   - Use the PB_FTS_CONFIG env var as JSON to select fields:
//     {"collection_name": ["field1", "field2"]}
//
// Note: PocketBase runs each hook callback as a standalone program in a
// separate VM that only has the shared bindings ($app, $os, $security, $http).
// Module-scope functions are NOT visible inside callbacks, so every callback
// below is fully self-contained.

// Auto-index on record create.
onRecordAfterCreateSuccess((e) => {
  const disabled = $os.getenv("PB_FTS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  let ftsConfig = {};
  try {
    ftsConfig = JSON.parse($os.getenv("PB_FTS_CONFIG") || "{}");
  } catch (err) {}

  const fields = ftsConfig[collection.name] || collection.fields
    .filter((f) => f.type() === "text" || f.type() === "editor" || f.type() === "json")
    .map((f) => f.name);

  if (fields.length === 0) return;

  const parts = [];
  for (const field of fields) {
    const value = e.record.get(field);
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      parts.push(value.join(" "));
    } else if (typeof value === "object") {
      parts.push(JSON.stringify(value));
    } else {
      parts.push(String(value));
    }
  }

  const title = e.record.get("title") || e.record.get("name") || e.record.id || "";
  const content = parts.join(" ");

  const db = $app.db();
  db.newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collection.name, id: e.record.id })
    .execute();
  db.newQuery(
    "INSERT INTO fts_records (collection, record_id, title, content) VALUES ({:col}, {:id}, {:title}, {:content})"
  )
    .bind({ col: collection.name, id: e.record.id, title: String(title), content })
    .execute();
});

// Auto-index on record update.
onRecordAfterUpdateSuccess((e) => {
  const disabled = $os.getenv("PB_FTS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  let ftsConfig = {};
  try {
    ftsConfig = JSON.parse($os.getenv("PB_FTS_CONFIG") || "{}");
  } catch (err) {}

  const fields = ftsConfig[collection.name] || collection.fields
    .filter((f) => f.type() === "text" || f.type() === "editor" || f.type() === "json")
    .map((f) => f.name);

  if (fields.length === 0) return;

  const parts = [];
  for (const field of fields) {
    const value = e.record.get(field);
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      parts.push(value.join(" "));
    } else if (typeof value === "object") {
      parts.push(JSON.stringify(value));
    } else {
      parts.push(String(value));
    }
  }

  const title = e.record.get("title") || e.record.get("name") || e.record.id || "";
  const content = parts.join(" ");

  const db = $app.db();
  db.newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collection.name, id: e.record.id })
    .execute();
  db.newQuery(
    "INSERT INTO fts_records (collection, record_id, title, content) VALUES ({:col}, {:id}, {:title}, {:content})"
  )
    .bind({ col: collection.name, id: e.record.id, title: String(title), content })
    .execute();
});

// Remove from index on record delete.
onRecordAfterDeleteSuccess((e) => {
  const disabled = $os.getenv("PB_FTS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  $app
    .db()
    .newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collection.name, id: e.record.id })
    .execute();
});
