# PocketBase on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/pocketbase-railway)

PocketBase on Railway automatically deploys a custom PocketBase build with a persistent volume, automatic admin setup, and vector search built in — no separate database service required.

**Unlike stock PocketBase, this template includes 5 features users commonly request:**

- **Full-text search** — FTS5-powered search with BM25 ranking and highlighted snippets, not slow `LIKE` queries
- **Soft delete** — Trash and restore records instead of permanent deletion
- **Webhooks** — Declarative HTTP callbacks when records change, with HMAC signing and automatic retries
- **Anonymous auth** — Guest sessions that users can convert to full accounts later
- **Bulk import** — CSV and JSON import with per-row error reporting

**After deployment:**

1. Access your admin dashboard at `https://<your-app>.up.railway.app/_/`
2. Log in with `admin@example.com` / `changeme123` (change the password immediately)
3. Start building — create collections in the dashboard or via the REST API

---

## What is PocketBase?

PocketBase is an open-source, single-binary backend that gives you a real-time database, authentication, file storage, and an admin dashboard — all in one file. It's the self-hosted alternative to Firebase and Supabase, built on SQLite with no external dependencies.

This template extends PocketBase with a custom Go binary that adds vector search (via SQLite's vec1 extension) and the features listed above, while keeping everything in a single container with persistent storage on Railway.

---

## What you get

Out of the box, without writing any backend code:

| Feature | Details |
|---------|---------|
| **Database** | SQLite with a REST API at `/api/collections/<name>/records` |
| **Auth** | Email/password, OAuth (Google, GitHub, etc.), passkeys, MFA, anonymous/guest |
| **File storage** | Uploads served from the same API |
| **Realtime** | Subscribe to record changes over SSE/WebSocket |
| **Admin dashboard** | Full UI at `/_/` for managing collections, data, and users |
| **Hooks & migrations** | Extend with JavaScript when you need custom logic |
| **Vector search** | `vec1` virtual tables for KNN queries (pgvector equivalent) |
| **Full-text search** | FTS5 with BM25 ranking, snippets, and highlight tags |

---

## Quick deploy

1. Click the **Deploy on Railway** button above, or use the CLI:

   ```bash
   railway login
   railway link
   npm install
   npm run apply
   ```

2. Railway builds the container and starts PocketBase. The data volume, healthcheck, and start command are all configured in `.railway/railway.ts`.

3. Open your admin dashboard at `https://<your-app>.up.railway.app/_/` and log in with:
   - Email: `admin@example.com`
   - Password: `changeme123`

   The app URL is set automatically from your Railway domain, so email links, OAuth redirects, and file URLs all point to the right place.

4. Start building. Create collections in the dashboard or via the API:

   ```bash
   curl -X POST https://<your-app>.up.railway.app/api/collections/posts/records \
     -H "Content-Type: application/json" \
     -d '{"title": "Hello World", "body": "My first post"}'
   ```

> **Important:** Change the default admin password immediately. The defaults are public and meant only for initial setup.

---

## Configuration

Everything is controlled by environment variables. Set them in the Railway dashboard or in `.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PB_ADMIN_EMAIL` | `admin@example.com` | Superuser email created on first boot |
| `PB_ADMIN_PASSWORD` | `changeme123` | Superuser password — **change this** |
| `PB_SKIP_ADMIN` | `false` | Set to `true` to skip auto-creating a superuser |
| `PB_DATA_DIR` | `/pb/pb_data` | Where SQLite data and uploads live |
| `PORT` | `8080` | HTTP port (Railway injects this) |
| `PB_PUBLIC_URL` | *(auto)* | Public URL for email links, OAuth redirects, and file URLs. Auto-derived from Railway's domain if left empty |
| `PB_APP_NAME` | *(empty)* | Override the app name shown in the dashboard |
| `PB_SMTP_HOST` | *(empty)* | Enable transactional email (password resets, verification, OTP) |
| `PB_BACKUPS_CRON` | *(empty)* | Scheduled backups cron expression, e.g. `0 2 * * *` |
| `PB_ENCRYPTION_KEY` | *(empty)* | 32+ character random string to encrypt settings at rest |
| `GOMEMLIMIT` | *(empty)* | Memory limit hint for the Go GC, e.g. `512MiB` |

**Tip:** Use Railway's sealed variables for secrets. Values set in the dashboard are preserved via `preserve()` in the IaC file.

### Data volume

Your database, uploads, and settings live on a persistent Railway volume mounted at `/pb/pb_data`. They survive redeploys and restarts. Need more space? Adjust the volume size in `.railway/railway.ts`.

### Backups

Use the **Settings → Backups** page in the admin dashboard to snapshot your data to a ZIP file. You can also set `PB_BACKUPS_CRON` for automatic scheduled backups.

---

## Vector search

PocketBase normally uses a SQLite driver that doesn't support extensions. This template swaps in the `ncruces/go-sqlite3` driver and registers [SQLite's vec1 extension](https://sqlite.org/vec1) on every connection — giving you pgvector-style vector search with zero additional infrastructure.

### How it works

`vec1` virtual tables live alongside your regular collections in the same SQLite file, but they're not exposed through the collections API. The pattern is simple: store your records in normal collections, keep embeddings in a `vec1` table keyed by record ID, and query via the `/api/vec/*` endpoints.

### Quick example

```bash
# Check that vec1 is loaded
curl https://<your-app>.up.railway.app/api/vec/health
# => {"enabled": true}

# Search for similar vectors
curl "https://<your-app>.up.railway.app/api/vec/search?vector=[1,1,1]&limit=5"
```

### Using the JavaScript SDK

```js
const pb = new PocketBase("https://<your-app>.up.railway.app");
const { results } = await pb.send("/api/vec/search", {
  query: { vector: "[1,1,1]", limit: 5 },
});
```

### Syncing embeddings from records

Keep embeddings as a `json` field on your records and mirror them into the `vec1` table automatically:

```js
// pb_hooks/embeddings.pb.js
onRecordAfterCreateSuccess((e) => {
  const emb = e.record.get("embedding");
  if (emb) {
    e.app.db().newQuery(
      "INSERT INTO vec_items(rowid, vector) VALUES ({:id}, vec1_from_json({:vec}))"
    ).bind({ id: e.record.id, vec: JSON.stringify(emb) }).execute();
  }
}, "documents");
```

For large-scale approximate nearest neighbor search, train a model with `vec1_train()` and rebuild the index — see the [vec1 documentation](https://sqlite.org/vec1) for details.

---

## Full-text search

PocketBase's `~` filter does unindexed substring matching. It works, but it gets slow on large text fields and offers no ranking. This template adds SQLite's FTS5 engine for proper full-text search.

### Usage

```bash
# Verify FTS5 is available
curl https://<your-app>.up.railway.app/api/search/health

# Search across all indexed collections
curl "https://<your-app>.up.railway.app/api/search?q=hello+world&limit=10"

# Search within a specific collection
curl "https://<your-app>.up.railway.app/api/search?q=hello&collection=posts"

# Reindex a collection (clears and rebuilds via hooks)
curl -X POST https://<your-app>.up.railway.app/api/search/reindex \
  -H "Content-Type: application/json" \
  -d '{"collection": "posts", "fields": ["title", "body"]}'
```

Results include highlighted snippets with `<mark>` tags and BM25 relevance ranking.

### How indexing works

Records are automatically synced to the FTS5 index on create, update, and delete via `pb_hooks/fts.pb.js`. By default, all text and editor fields are indexed. To control which fields are indexed for a specific collection, set the `PB_FTS_CONFIG` environment variable:

```bash
PB_FTS_CONFIG='{"posts": ["title", "body"], "articles": ["headline", "content"]}'
```

---

## Soft delete

Deleting a record in PocketBase is permanent — it's gone. This template changes that behavior: deleting a record sets a `deleted_at` timestamp instead of removing it. The record disappears from normal queries but can be restored or permanently purged later.

### API

```bash
# "Delete" a record (sets deleted_at)
curl -X DELETE https://<your-app>.up.railway.app/api/collections/posts/records/RECORD_ID

# View soft-deleted records
curl "https://<your-app>.up.railway.app/api/trash/posts?limit=50"

# Restore a record
curl -X POST https://<your-app>.up.railway.app/api/restore/posts/RECORD_ID

# Permanently delete
curl -X DELETE https://<your-app>.up.railway.app/api/purge/posts/RECORD_ID
```

New collections automatically get a `deleted_at` field via `pb_hooks/soft_delete.pb.js`.

---

## Webhooks

Webhooks let you configure HTTP callbacks that fire when records change — useful for triggering external services, updating CDNs, or syncing data. Unlike PocketBase's code-based hooks, these are declarative: you configure them by inserting records into the `webhooks` table, and they work without deploying custom code.

### Features

- HMAC-SHA256 signature verification
- Per-collection or global event filtering
- Custom headers
- Automatic retries with exponential backoff
- Delivery logging

### Setup

Insert a record into the `webhooks` table (via the admin UI or API):

```json
{
  "url": "https://example.com/webhook",
  "events": "create,update,delete",
  "collection": "posts",
  "secret": "your-signing-secret",
  "headers": {"X-Custom": "value"}
}
```

- `url` — where to send the callback
- `events` — comma-separated list (`create`, `update`, `delete`) or `*` for all
- `collection` — optional; omit to fire for all collections
- `secret` — optional; used to sign payloads with HMAC-SHA256
- `headers` — optional JSON object of additional headers

### Testing and monitoring

```bash
# Send a test event
curl -X POST https://<your-app>.up.railway.app/api/webhooks/test \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/webhook", "secret": "my-secret"}'

# View recent delivery attempts
curl "https://<your-app>.up.railway.app/api/webhooks/deliveries?webhook_id=WEBHOOK_ID"
```

---

## Anonymous auth

Sometimes you want to let users interact with your app before they sign up — guest shopping carts, personalized landing pages, "try before you commit" flows. This template adds anonymous authentication for that.

### How it works

An anonymous session creates a temporary auth record. The user gets a valid token and can interact with your app normally. When they're ready to sign up, the anonymous account is "claimed" — converted to a full account with their real email and password.

### API

```bash
# Create an anonymous session
curl -X POST https://<your-app>.up.railway.app/api/auth/anonymous
# => {"token": "...", "record": {...}}

# Claim the account (convert to a real user)
curl -X POST https://<your-app>.up.railway.app/api/auth/anonymous/claim \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secure123", "password_confirm": "secure123"}'
```

---

## Bulk import

Moving data into PocketBase usually means writing a script that loops over records and makes individual API calls. This template provides import endpoints that handle CSV and JSON files directly, with per-row error reporting so you know exactly which rows succeeded and which failed.

### CSV import

```bash
curl -X POST "https://<your-app>.up.railway.app/api/import/csv?collection=posts" \
  -F "file=@data.csv"
```

The first row is treated as headers and mapped to field names.

### JSON import

```bash
curl -X POST "https://<your-app>.up.railway.app/api/import/json?collection=posts" \
  -H "Content-Type: application/json" \
  -d '[{"title": "Post 1"}, {"title": "Post 2"}]'
```

### Response format

Both endpoints return per-row results:

```json
{
  "collection": "posts",
  "total": 2,
  "imported": 1,
  "failed": 1,
  "results": [
    {"row": 1, "id": "abc123", "status": "success"},
    {"row": 2, "status": "error", "error": "..."}
  ]
}
```

---

## Extending PocketBase

### Migrations

Migrations are JavaScript files that run once and are tracked in the `_migrations` table. They apply automatically on deploy.

Create your own:

```
pb_migrations/20240901000000_create_projects.js
```

```js
migrate((app) => {
  const collection = new Collection({ name: "projects", type: "base", /* ... */ });
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("projects");
  if (collection) app.delete(collection);
});
```

See the [JS migrations documentation](https://pocketbase.io/docs/js-migrations/).

### Hooks

Hooks are JavaScript files that run on every request or record event. Place them in `pb_hooks/` and they're loaded automatically.

`pb_hooks/examples.pb.js` ships with commented examples for custom routes, record validation, and logging. Uncomment what you need and redeploy.

See the [JS hooks documentation](https://pocketbase.io/docs/js-overview/).

### Client SDKs

```js
import PocketBase from "pocketbase";
const pb = new PocketBase("https://<your-app>.up.railway.app");
const posts = await pb.collection("posts").getFullList();
```

Official SDKs exist for JavaScript and Dart/Flutter. Community clients are available for many other languages.

---

## Local development

The Dockerfile builds a custom PocketBase binary with the vec1 extension compiled in. To run the same setup locally, you need Go 1.27+:

```bash
# Build the custom binary
go build -tags no_default_driver \
  -ldflags "-X github.com/ncruces/go-sqlite3/driver.driverName=sqlite" \
  -o pocketbase .

# Run with migrations and hooks
./pocketbase serve
```

Data will be stored in `./pb_data` on your local machine.

---

## How it all fits together

| File | Purpose |
|------|---------|
| `main.go` | Custom PocketBase launcher. Swaps in the ncruces SQLite driver, registers the vec1 extension, loads JS hooks/migrations, and adds all the extra API routes |
| `Dockerfile` | Multi-stage build: compiles the Go binary in stage 1, runs it in a slim Alpine container in stage 2 |
| `entrypoint.sh` | Creates the admin superuser from environment variables, then starts PocketBase |
| `.railway/railway.ts` | Railway Infrastructure as Code — defines the service, volume, healthcheck, and environment variables |
| `pb_migrations/20250101000000_enable_vec.js` | Creates the vec1 virtual table for vector search |
| `pb_migrations/20250905000000_enable_fts.js` | Creates the FTS5 virtual table for full-text search |
| `pb_migrations/20250905000001_webhooks_table.js` | Creates tables for webhook configurations and delivery logs |
| `pb_hooks/config.pb.js` | Syncs environment variables to PocketBase settings on every boot |
| `pb_hooks/fts.pb.js` | Automatically indexes records in FTS5 on create, update, and delete |
| `pb_hooks/webhooks.pb.js` | Dispatches webhook events with retry logic |
| `pb_hooks/soft_delete.pb.js` | Automatically adds `deleted_at` field to new collections |

---

## Security checklist

Before going to production:

- [ ] Change `PB_ADMIN_PASSWORD` (or set `PB_SKIP_ADMIN=true`)
- [ ] Set `PB_ENCRYPTION_KEY` to a long random string
- [ ] Tighten collection rules (`listRule`, `createRule`, etc.) in the admin UI
- [ ] Configure a real SMTP server for transactional email
- [ ] Enable the rate limiter in Settings → Application

---

## Resources

- [PocketBase documentation](https://pocketbase.io/docs/)
- [PocketBase GitHub](https://github.com/pocketbase/pocketbase)
- [Railway documentation](https://docs.railway.com)
- [SQLite vec1 extension](https://sqlite.org/vec1)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
