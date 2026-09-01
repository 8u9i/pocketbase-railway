# PocketBase on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

**A one-click backend for your next app.** This template deploys [PocketBase](https://pocketbase.io) — the open-source, single-binary alternative to Supabase/Firebase — to [Railway](https://railway.com) with a persistent volume, a working admin dashboard, a sample database already seeded, and **vector search built in** (SQLite's `vec1` engine, the equivalent of pgvector — no separate Postgres service needed).

You get all of this without writing a single line of backend code:

- **Database** — SQLite with a REST-ish API (`/api/collections/<name>/records`)
- **Auth** — email/password, OAuth (Google, GitHub, …), passkeys, MFA
- **File storage** — uploads served from the same API
- **Realtime** — subscribe to record changes over SSE/WebSocket
- **Admin dashboard** — a full UI at `/_/` to manage collections, data, and users
- **Hooks & migrations** — extend it with JavaScript when you outgrow the defaults
- **Vector search** — `vec1` virtual tables + KNN queries, all inside the same binary/SQLite file

---

## 🚀 Deploy (Beginner)

1. Click **Deploy on Railway** above, or via CLI:
   ```bash
   railway login
   railway link
   npm install          # installs the railway IaC CLI package
   npm run apply        # plans + applies the service, volume, and variables
   ```
2. Railway builds the container and starts PocketBase automatically — the data volume, healthcheck, and start command are all configured in `.railway/railway.ts`.
3. Open the admin dashboard at **`https://<your-app>.up.railway.app/_/`** and log in with:
   - Email: `admin@example.com`
   - Password: `changeme123`

   The dashboard "App URL" (Settings → Application) is set automatically from your deployment URL, so email links, OAuth2 redirects, and file URLs point at the live site — not `localhost`.
4. You're in. Browse the seeded `todos` collection, create your own collections, and use the API:

```bash
# List todos (public by default, see the sample migration)
curl https://<your-app>.up.railway.app/api/collections/todos/records

# Create a todo
curl -X POST https://<your-app>.up.railway.app/api/collections/todos/records \
  -H "Content-Type: application/json" \
  -d '{"title": "Ship my app", "done": false}'
```

> ⚠️ **Change the default admin password immediately.** `admin@example.com` / `changeme123` are public defaults (see below).

---

## ⚙️ Configure (Intermediate)

Everything is controlled by environment variables. Set them in the Railway dashboard (or `.env`) and redeploy.

| Variable | Default | Description |
| --- | --- | --- |
| `PB_ADMIN_EMAIL` | `admin@example.com` | Superuser email created on first boot. |
| `PB_ADMIN_PASSWORD` | `changeme123` | Superuser password. **Change this!** |
| `PB_SKIP_ADMIN` | `false` | `true` = don't auto-create a superuser; use the installer link from the logs instead. |
| `PB_DATA_DIR` | `/pb/pb_data` | Where SQLite data + uploads live (keep it on the volume). |
| `PORT` | `8080` | HTTP port (Railway injects this). |
| `PB_PUBLIC_URL` | *(auto)* | Public URL used for email links, OAuth2 redirects, file URLs, and the dashboard "App URL". Leave empty to auto-derive `https://<your-app>.up.railway.app` from Railway's `RAILWAY_PUBLIC_DOMAIN`; set it explicitly when you attach a custom domain. |
| `PB_APP_NAME` | *(empty)* | Overrides the app name shown in the dashboard. |
| `PB_SMTP_HOST` / `PB_SMTP_PORT` / `PB_SMTP_USERNAME` / `PB_SMTP_PASSWORD` | *(empty)* | Set `PB_SMTP_HOST` to enable transactional email (password resets, verification, OTP). Port defaults to `587`, auth method to `PLAIN`, TLS to `true`. |
| `PB_BACKUPS_CRON` / `PB_BACKUPS_CRON_MAX_KEEP` | *(empty)* / `7` | Scheduled backups cron (e.g. `0 2 * * *`) and how many to keep. |
| `PB_ENCRYPTION_KEY` | *(empty)* | 32+ char random string; encrypts PocketBase settings at rest. |
| `GOMEMLIMIT` | *(empty)* | e.g. `512MiB` to keep the Go GC memory-aware on small plans. |

**Set real credentials as sealed variables** in Railway so they never appear in your repo or template. The IaC file keeps any value you set in the dashboard via `preserve()`.

### The data volume

`pb_data/` is mounted on a persistent Railway volume, so your database, uploads, and settings survive redeploys and restarts. Need more space? Bump the volume size in `.railway/railway.ts`.

### Backups

Use the built-in **Settings → Backups** page in the admin dashboard (or the `pocketbase backup` CLI) to snapshot `pb_data` to a ZIP.

---

## 🧩 Extend (Advanced)

PocketBase is extensible with JavaScript — no separate app server needed. This template additionally ships a custom Go build (`main.go` + multi-stage `Dockerfile`) that bakes **vec1** (SQLite's official vector search engine) into the SQLite engine itself.

### Vector search (pgvector-style)

`vec1` virtual tables give you the SQLite equivalent of pgvector `vector` columns + ANN indexes, with zero extra infrastructure:

```sql
-- vec1 virtual table (see pb_migrations/20250101000000_enable_vec.js)
CREATE VIRTUAL TABLE vec_items USING vec1(vector);

-- insert a vector (stored as a float32 BLOB via vec1_from_json)
INSERT INTO vec_items(rowid, vector) VALUES (NULL, vec1_from_json('[1, 1, 1]'));

-- KNN query: nearest neighbors (table-valued function form)
SELECT rowid, distance
FROM vec_items(vec1_from_json('[1, 1, 1]'), '{k:5}');
```

The template ships a ready-made API for this:

```bash
# Health check - confirms vec1 is loaded
curl https://<your-app>.up.railway.app/api/vec/health
# => {"enabled":true}

# KNN search against the seeded vec_items table
curl "https://<your-app>.up.railway.app/api/vec/search?vector=[1,1,1]&limit=3"
```

To query from your own code (JS SDK example):

```js
const pb = new PocketBase("https://<your-app>.up.railway.app");
const { results } = await pb.send("/api/vec/search", {
  query: { vector: "[1,1,1]", limit: 5 },
});
```

> `vec1` tables live in the same `pb_data/data.db` as your collections but are **not** exposed through the collections API (they're virtual tables). The pattern is: keep your records in normal collections, store embeddings in a `vec1` table keyed by record id, and expose KNN via a small Go route (`main.go` shows a complete example). For ANN at scale, train a model with `vec1_train()` and `INSERT INTO vec_items(cmd, arg) VALUES('rebuild', :model)` — see https://sqlite.org/vec1.

### Storing embeddings on your records (the pgvector workflow)

The `vec_items` table stores vectors directly, but for a real app you usually want the embedding attached to a normal collection so you can CRUD it through the standard API and `expand`/`filter` on it. Do both: keep the vector as a `json` field on the record, and mirror it into the `vec1` table for search (keyed by record id).

**1. Add an `embedding` `json` field to your collection** (Dashboard → collection → add field, type JSON). Example via migration:

```js
migrate((app) => {
  const c = app.findCollectionByNameOrId("documents");
  if (!c) return;
  c.fields.add({ name: "embedding", type: "json" });
  app.save(c);
});
```

**2. Sync it into `vec_items` automatically** — add to `pb_hooks/` (e.g. `pb_hooks/embeddings.pb.js`):

```js
// keep the vec1 mirror in sync with the record's embedding field
onRecordAfterCreateSuccess((e) => {
  const emb = e.record.get("embedding");
  if (emb) {
    e.app.db().newQuery(
      "INSERT INTO vec_items(rowid, vector) VALUES ({:id}, vec1_from_json({:vec}))"
    ).bind({ id: e.record.id, vec: JSON.stringify(emb) }).execute();
  }
}, "documents");

onRecordAfterUpdateSuccess((e) => {
  const emb = e.record.get("embedding");
  if (emb) {
    e.app.db().newQuery(
      "UPDATE vec_items SET vector = vec1_from_json({:vec}) WHERE rowid = {:id}"
    ).bind({ id: e.record.id, vec: JSON.stringify(emb) }).execute();
  }
}, "documents");

onRecordAfterDeleteSuccess((e) => {
  e.app.db().newQuery("DELETE FROM vec_items WHERE rowid = {:id}")
    .bind({ id: e.record.id }).execute();
}, "documents");
```

**3. Search and get full records back** — the `/api/vec/search` endpoint returns matching `rowid`s (your record ids); fetch the records with the normal API:

```js
const pb = new PocketBase("https://<your-app>.up.railway.app");
const { results } = await pb.send("/api/vec/search", {
  query: { vector: "[...embedding...]", limit: 10 },
});
const ids = results.map((r) => r.RowID);
const docs = await pb.collection("documents").getFullList({
  filter: ids.map((id) => `id = '${id}'`).join(" || "),
});
// docs is now ordered by KNN similarity
```

That's the complete pgvector workflow — store/update/delete embeddings through PocketBase like any field, and query by similarity — all inside the one service.

### Migrations

The template ships a sample migration at `pb_migrations/20240801000000_sample_todos.js` that creates the `todos` collection and seeds it. Migrations run once (tracked in `_migrations`) and apply automatically on deploy.

Add your own:

```bash
# Name files <YYYYMMDDHHMMSS>_<description>.js
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

See [JS migrations docs](https://pocketbase.io/docs/js-migrations/).

### Hooks

`pb_hooks/examples.pb.js` ships with commented examples (a public `/api/hello` route, record hooks, validation). Uncomment, redeploy, done. See [JS hooks docs](https://pocketbase.io/docs/js-overview/).

### Client SDKs

```js
import PocketBase from "pocketbase";
const pb = new PocketBase("https://<your-app>.up.railway.app");
const todos = await pb.collection("todos").getFullList();
```

SDKs exist for JS, Dart/Flutter, and community clients for many languages.

### Local development

The Dockerfile builds a custom PocketBase binary with sqlite-vec baked in (see `main.go`). To run the same thing locally you need Go 1.27+:

```bash
# Build the custom binary (requires Go 1.27+)
GOTOOLCHAIN=go1.27.0 go build -tags no_default_driver \
  -ldflags "-X github.com/ncruces/go-sqlite3/driver.driverName=sqlite" \
  -o pocketbase .

# Run migrations + hooks locally against ./pb_data
./pocketbase serve
```

---

## 🔒 Security checklist

- [ ] Change `PB_ADMIN_PASSWORD` (or set `PB_SKIP_ADMIN=true` and create the superuser from the installer link).
- [ ] Set `PB_ENCRYPTION_KEY` to a long random string.
- [ ] Tighten collection rules (`listRule` / `createRule` / …) in the admin UI — the sample `todos` collection is wide open by design.
- [ ] Configure a real SMTP server in **Settings → Mail** so password resets and verification emails actually send.
- [ ] Enable the built-in **rate limiter** in Settings → Application.

---

## How this template works

- `main.go` — a custom PocketBase launcher. It swaps the stock modernc SQLite driver for the CGO-free `ncruces/go-sqlite3` driver and registers SQLite's **vec1** vector extension on every connection (`sqlite3.AutoExtension(vec1.Register)`). It also registers the JS runtime (`jsvm`) so `pb_hooks/` and `pb_migrations/` work, and adds Go routes for `/api/vec/health` and `/api/vec/search`. Set `PB_VEC_DISABLED=1` to fall back to the stock driver.
- `Dockerfile` — multi-stage build: stage 1 compiles the custom binary in a Go 1.27 image (`-tags no_default_driver` + ldflags driver rename), stage 2 is the same slim Alpine image as the stock template. Still one service, one container, one `pb_data` volume.
- `pb_migrations/20250101000000_enable_vec.js` — creates and seeds the `vec_items` vec1 table (fails with a clear message if run on the stock binary).
- `entrypoint.sh` — creates the admin superuser from env vars on first boot, then starts `pocketbase serve`.
- `.railway/railway.ts` — Railway Infrastructure as Code (the current, supported system): declares the service, the `pocketbase-data` volume, healthcheck, and variables. Manage it with `npm run plan` / `npm run apply` (requires `railway login` + `railway link`). See [Railway IaC docs](https://docs.railway.com/infrastructure-as-code).

## Resources

- [PocketBase docs](https://pocketbase.io/docs/) · [PocketBase GitHub](https://github.com/pocketbase/pocketbase) · [Railway docs](https://docs.railway.com)
