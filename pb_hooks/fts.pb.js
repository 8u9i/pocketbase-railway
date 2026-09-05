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

const FTS_DISABLED = (() => {
  const v = $os.getenv("PB_FTS_DISABLED");
  return v === "true" || v === "1";
})();

const FTS_CONFIG = (() => {
  try {
    return JSON.parse($os.getenv("PB_FTS_CONFIG") || "{}");
  } catch {
    return {};
  }
})();

// Fields to extract text from for each collection.
// Default: all text/editor/json fields are indexed.
function getFieldsToIndex(collection) {
  if (FTS_CONFIG[collection.name]) {
    return FTS_CONFIG[collection.name];
  }
  return collection.fields
    .filter((f) => f.type() === "text" || f.type() === "editor" || f.type() === "json")
    .map((f) => f.name);
}

// Extract searchable text from a record.
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

// Index a single record into FTS.
function indexRecord(collectionName, record, fields) {
  const db = $app.db();

  db.newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collectionName, id: record.id })
    .execute();

  const title = record.get("title") || record.get("name") || record.id || "";
  const content = extractText(record, fields);

  db.newQuery(
    "INSERT INTO fts_records (collection, record_id, title, content) VALUES ({:col}, {:id}, {:title}, {:content})"
  )
    .bind({ col: collectionName, id: record.id, title: String(title), content })
    .execute();
}

// Remove a record from the FTS index.
function deindexRecord(collectionName, recordId) {
  $app
    .db()
    .newQuery("DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}")
    .bind({ col: collectionName, id: recordId })
    .execute();
}

// Auto-index on record create.
onRecordAfterCreateSuccess((e) => {
  if (FTS_DISABLED) return;
  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;
  const fields = getFieldsToIndex(collection);
  if (fields.length === 0) return;
  indexRecord(collection.name, e.record, fields);
});

// Auto-index on record update.
onRecordAfterUpdateSuccess((e) => {
  if (FTS_DISABLED) return;
  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;
  const fields = getFieldsToIndex(collection);
  if (fields.length === 0) return;
  indexRecord(collection.name, e.record, fields);
});

// Remove from index on record delete.
onRecordAfterDeleteSuccess((e) => {
  if (FTS_DISABLED) return;
  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;
  deindexRecord(collection.name, e.record.id);
});
