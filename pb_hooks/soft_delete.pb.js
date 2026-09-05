// Soft delete - intercepts record deletions to set deleted_at instead of removing.
//
// This hook provides a "trash" system for PocketBase records. Instead of
// permanently deleting records, it sets a `deleted_at` timestamp. Records
// with `deleted_at` set are excluded from normal queries but can be restored
// or permanently purged.
//
// Routes (in main.go):
//   - DELETE /api/collections/:collection/records/:id  -> sets deleted_at (via Go middleware)
//   - POST /api/restore/:collection/:id                -> clears deleted_at
//   - GET /api/trash/:collection                       -> lists soft-deleted records
//   - DELETE /api/purge/:collection/:id                 -> permanently deletes
//
// Config: set PB_SOFT_DELETE_DISABLED=1 to allow real deletes.

// Auto-add deleted_at field to new collections
onCollectionCreateSuccess((e) => {
  if (env.PB_SOFT_DELETE_DISABLED === "true" || env.PB_SOFT_DELETE_DISABLED === "1") return;

  const collection = e.collection;
  if (!collection || collection.name.startsWith("_")) return;

  // Check if field already exists
  const hasField = collection.fields.some((f) => f.name === "deleted_at");
  if (hasField) return;

  // Add deleted_at field
  collection.fields.add({
    name: "deleted_at",
    type: "date",
    hidden: true,
    system: false,
  });

  app.save(collection);
});
