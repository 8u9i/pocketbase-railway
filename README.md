# PocketBase on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

**A one-click backend for your next app.** This template deploys [PocketBase](https://pocketbase.io) — the open-source, single-binary alternative to Supabase/Firebase — to [Railway](https://railway.com) with a persistent volume, a working admin dashboard, and a sample database already seeded.

You get all of this without writing a single line of backend code:

- **Database** — SQLite with a REST-ish API (`/api/collections/<name>/records`)
- **Auth** — email/password, OAuth (Google, GitHub, …), passkeys, MFA
- **File storage** — uploads served from the same API
- **Realtime** — subscribe to record changes over SSE/WebSocket
- **Admin dashboard** — a full UI at `/_/` to manage collections, data, and users
- **Hooks & migrations** — extend it with JavaScript when you outgrow the defaults

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
| `PB_ENCRYPTION_KEY` | *(empty)* | 32+ char random string; encrypts PocketBase settings at rest. |
| `GOMEMLIMIT` | *(empty)* | e.g. `512MiB` to keep the Go GC memory-aware on small plans. |

**Set real credentials as sealed variables** in Railway so they never appear in your repo or template. The IaC file keeps any value you set in the dashboard via `preserve()`.

### The data volume

`pb_data/` is mounted on a persistent Railway volume, so your database, uploads, and settings survive redeploys and restarts. Need more space? Bump the volume size in `.railway/railway.ts`.

### Backups

Use the built-in **Settings → Backups** page in the admin dashboard (or the `pocketbase backup` CLI) to snapshot `pb_data` to a ZIP.

---

## 🧩 Extend (Advanced)

PocketBase is extensible with JavaScript — no separate app server needed.

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

```bash
# Download the PocketBase binary for your OS, or:
curl -L https://github.com/pocketbase/pocketbase/releases/download/v0.40.1/pocketbase_0.40.1_linux_amd64.zip -o pb.zip && unzip pb.zip

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

- `Dockerfile` — multi-arch (amd64/arm64) Alpine image pinned to PocketBase `v0.40.1`; copies in `pb_migrations/` and `pb_hooks/`.
- `entrypoint.sh` — creates the admin superuser from env vars on first boot, then starts `pocketbase serve`.
- `.railway/railway.ts` — Railway Infrastructure as Code (the current, supported system): declares the service, the `pocketbase-data` volume, healthcheck, and variables. Manage it with `npm run plan` / `npm run apply` (requires `railway login` + `railway link`). See [Railway IaC docs](https://docs.railway.com/infrastructure-as-code).

## Resources

- [PocketBase docs](https://pocketbase.io/docs/) · [PocketBase GitHub](https://github.com/pocketbase/pocketbase) · [Railway docs](https://docs.railway.com)
