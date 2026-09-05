// FTS5 auto-sync hook - keeps the full-text search index in sync with records.
//
// This hook automatically indexes records into the fts_records FTS5 virtual table
// whenever they are created, updated, or deleted. It extracts searchable text
// from configured fields on each collection.
//
// Configuration:
//   - Set PB_FTS_DISABLED=true to disable indexing
//   - Collections with no FTS_CONFIG are indexed using all text fields
//
// Per-collection config (optional): add a comment to your collection's JSON schema
// or use the FTS_CONFIG env var as JSON: {"collection_name": ["field1", "field2"]}

const FTS_CONFIG = (() => {
  try {
    return JSON.parse(env.PFTS_CONFIG || "{}");
  } catch {
    return {};
  }
})();

// Fields to extract text from for each collection
// Default: all text/json fields are indexed
function getFieldsToIndex(collection) {
  if (FTS_CONFIG[collection.name]) {
    return FTS_CONFIG[collection.name];
  }
  // Auto-detect text fields
  return collection.fields
    .filter((f) => f.type === "text" || f.type === "editor" || f.type === "json")
    .map((f) => f.name);
}

// Extract searchable text from a record
function extractText(record, fields) {
  const parts = [];
  for (const field of fields) {
    const value = record.get(field);
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
  return parts.join(" ");
}

// Index a single record into FTS
function indexRecord(collectionName, record, fields) {
  const db = app.db();
  const recordId = record.id;

  // Delete existing index entry (if any)
  db.newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collectionName, id: recordId })
    .execute();

  // Insert new index entry
  const title = record.get("title") || record.get("name") || record.get("id") || "";
  const content = extractText(record, fields);

  db.newQuery(
    "INSERT INTO fts_records (collection, record_id, title, content) VALUES ({:col}, {:id}, {:title}, {:content})"
  )
    .bind({ col: collectionName, id: recordId, title: String(title), content })
    .execute();
}

// Remove a record from FTS index
function deindexRecord(collectionName, recordId) {
  app
    .db()
    .newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collectionName, id: recordId })
    .execute();
}

// Register hooks for all non-system collections
onCollectionCreateSuccess((e) => {
  // New collection created - no records to index yet
});

// Auto-index on record create
onRecordAfterCreateRequest((e) => {
  if (env.PB_FTS_DISABLED === "true" || env.PB_FTS_DISABLED === "1") return;
  const collection = e.collection;
  if (!collection || collection.name.startsWith("_")) return; // skip system collections
  const fields = getFieldsToIndex(collection);
  if (fields.length === 0) return;
  indexRecord(collection.name, e.record, fields);
});

// Auto-index on record update
onRecordAfterUpdateSuccess((e) => {
  if (env.PB_FTS_DISABLED === "true" || env.PB_FTS_DISABLED === "1") return;
  const collection = e.collection;
  if (!collection || collection.name.startsWith("_")) return;
  const fields = getFieldsToIndex(collection);
  if (fields.length === 0) return;
  indexRecord(collection.name, e.record, fields);
});

// Remove from index on record delete
onRecordAfterDeleteSuccess((e) => {
  if (env.PB_FTS_DISABLED === "true" || env.PB_FTS_DISABLED === "1") return;
  const collection = e.collection;
  if (!collection || collection.name.startsWith("_")) return;
  deindexRecord(collection.name, e.record.id);
});
