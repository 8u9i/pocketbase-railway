// PocketBase JS migration - creates tables for the webhook engine.
//
// Webhooks let you declaratively configure HTTP callbacks that fire when
// records are created, updated, or deleted. This is a core BaaS feature
// that competitors (Supabase, Firebase, Appwrite) all provide.
//
// Tables:
//   - webhooks: webhook configurations (URL, events, secret, headers)
//   - webhook_deliveries: delivery log with status, response, retry count
//
// Config: set PB_WEBHOOKS_DISABLED=1 to skip.

migrate(
  (app) => {
    const db = app.db();

    // Webhook configurations
    db.newQuery(`CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'create,update,delete',
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      headers TEXT,
      collection TEXT,
      created DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).execute();

    // Delivery log
    db.newQuery(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at DATETIME,
      created DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).execute();

    // Indexes for common queries
    db.newQuery("CREATE INDEX IF NOT EXISTS idx_webhooks_collection ON webhooks(collection)").execute();
    db.newQuery("CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled)").execute();
    db.newQuery("CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id)").execute();
    db.newQuery("CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON webhook_deliveries(next_retry_at)").execute();

    console.log("==> Webhook engine tables created (webhooks, webhook_deliveries)");
  },
  (app) => {
    const db = app.db();
    db.newQuery("DROP TABLE IF EXISTS webhooks").execute();
    db.newQuery("DROP TABLE IF EXISTS webhook_deliveries").execute();
  }
);
