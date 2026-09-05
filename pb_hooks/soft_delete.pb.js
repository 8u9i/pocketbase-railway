// Soft delete - intercepts record deletions to set deleted_at instead of removing.
//
// This hook provides a "trash" system for PocketBase records. Instead of
// permanently deleting records, it sets a `deleted_at` timestamp. Records
// with `deleted_at` set are excluded from normal queries but can be restored
// or permanently purged later.
//
// Routes (in main.go):
//   - DELETE /api/collections/:collection/records/:id -> sets deleted_at
//   - POST /api/restore/:collection/:id                 -> clears deleted_at
//   - GET /api/trash/:collection                        -> lists soft-deleted records
//   - DELETE /api/purge/:collection/:id                 -> permanently deletes
//
// Config: set PB_SOFT_DELETE_DISABLED=true to skip auto-adding the field.

// Auto-add deleted_at field to newly created collections.
onCollectionAfterCreateSuccess((e) => {
  const disabled = $os.getenv("PB_SOFT_DELETE_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.collection;
  if (!collection || collection.name.startsWith("_")) return;

  const hasField = collection.fields.some((f) => f.name === "deleted_at");
  if (hasField) return;

  collection.fields.add(new DateField({
    name: "deleted_at",
    hidden: true,
    system: false,
  }));

  $app.save(collection);
});
