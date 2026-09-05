# Deploy and Host PocketBase on Railway

[![PocketBase](https://avatars.githubusercontent.com/u/101000011?v=4)](https://pocketbase.io)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/pocketbase-railway?referralCode=qVHjLS)

You know that feeling when you need a backend but don't want to spend days wiring up a database, auth, file storage, and an admin panel? PocketBase gives you all of that in a single ~12MB Go executable. This template deploys it to Railway with a persistent volume, automatic admin setup, and five features that stock PocketBase is missing, so it actually works the moment it's online.

## What makes this template different

Most PocketBase templates give you the stock binary and call it a day. This one ships a custom Go build that adds the features developers consistently ask for. You get full-text search with BM25 ranking instead of slow `LIKE` queries. You get soft delete with a trash bin instead of permanent data loss. You get declarative webhooks that fire when records change, with HMAC signing and automatic retries. You get anonymous auth for guest sessions that convert to real accounts later. And you get CSV and JSON bulk import with per-row error reporting.

All of this runs in a single container. Your data lives in SQLite on a Railway volume. No external services to configure, no separate search index to maintain, no webhook infrastructure to build.

## About Hosting PocketBase on Railway

Railway builds a multi-arch Alpine image from the custom Go binary, then runs it with a persistent volume mounted at `/pb/pb_data`. Your database, uploads, and settings survive redeploys and restarts. An entrypoint script handles first-boot setup, creating the admin superuser from environment variables. A healthcheck on `/api/health` keeps the service honest.

Versioned JavaScript migrations and hooks are copied into the image, so schema changes and custom logic deploy automatically with each push. No manual migration steps, no SSH into containers to run scripts.

The entrypoint script resolves admin credentials and data directory from environment variables, creates the superuser on first boot, then starts PocketBase:

```sh
/pb/pocketbase superuser create "${PB_ADMIN_EMAIL}" "${PB_ADMIN_PASSWORD}" --dir="${PB_DATA_DIR}" || true
exec /pb/pocketbase serve --http="0.0.0.0:${PORT:-8080}" --dir="${PB_DATA_DIR}"
```

The `|| true` means if a superuser already exists (you've deployed before), the command silently succeeds and PocketBase starts normally. No errors, no failed containers.

## Common Use Cases

**Backend for web and mobile apps.** Authentication, data, and file storage through a REST API. No server code to write, no ORM to configure, no auth provider to integrate. Create a collection in the dashboard, set your rules, and start making API calls.

**Internal tools and admin panels.** The built-in dashboard at `/_/` manages collections, records, and users out of the box. Give your team a URL, and they have a working admin interface without you building one.

**Rapid prototyping.** Deploy a working backend in one click, seed it with migrations, and iterate with official SDKs for JavaScript and Dart/Flutter. When you're ready to customize, add JavaScript hooks for custom routes, record validation, and event-driven logic.

**AI-powered applications.** The custom build includes SQLite's vec1 extension for vector search, giving you pgvector-style KNN queries without a separate database service. Store embeddings alongside your records and query by similarity, all in the same SQLite file.

## Dependencies for PocketBase Hosting

A Railway account and this template. That's it.

The template creates a 512 MB persistent volume by default, which you can resize anytime in `.railway/railway.ts`. Set `PB_ADMIN_EMAIL` and `PB_ADMIN_PASSWORD` in the Railway dashboard, or leave the defaults for initial setup (and change them immediately after).

No external databases to provision. No separate search services to configure. No additional infrastructure beyond what Railway provides out of the box.

## Why Deploy PocketBase on Railway

Railway handles the infrastructure so you don't have to. Automatic TLS at the edge, public domains, healthchecks, and zero-downtime deploys. You focus on building your app, not configuring servers.

When you need more resources, scale vertically or horizontally from the dashboard. When you need to add services, they're on the same private network with no extra configuration. Your PocketBase instance can talk to other services in your project without exposing them publicly.

Railway is a singular platform to deploy your entire infrastructure stack. By deploying PocketBase on Railway, you're one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

## The five extra features in detail

**Full-text search.** PocketBase's `~` filter does unindexed substring matching. It works for small datasets but slows down fast as you add records. This template adds SQLite's FTS5 engine with BM25 relevance ranking, highlighted search snippets, and prefix queries. Records index automatically on create, update, and delete.

**Soft delete.** Deleting a record in PocketBase is permanent. This template sets a `deleted_at` timestamp instead, hiding the record from normal queries while keeping it recoverable. Restore it when needed, or purge it permanently when you're sure.

**Webhooks.** Configure HTTP callbacks that fire when records change. Set them up by inserting records into a `webhooks` table, no code deployment required. Each webhook supports HMAC-SHA256 signatures, custom headers, and automatic retries with exponential backoff on failure.

**Anonymous auth.** Let users interact with your app before they sign up. Anonymous sessions create temporary auth records with valid tokens. When users are ready to commit, they claim the account by providing their email and password, converting the anonymous session into a full account.

**Bulk import.** Moving data into PocketBase usually means writing a script that loops over records and makes individual API calls. This template accepts CSV and JSON files directly, importing them with per-row error reporting so you know exactly which rows succeeded and which failed.
