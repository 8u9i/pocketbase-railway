import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// PocketBase: a single-binary backend (SQLite, auth, file storage, realtime,
// admin UI, REST API) deployed to Railway.
//
// Infrastructure as Code (IaC) is Railway's current, supported system - it
// replaces the deprecated railway.json / railway.toml "Config as Code".
// Docs: https://docs.railway.com/infrastructure-as-code

const pbData = volume("pocketbase-data", {
  region: "us-west2",
  sizeMB: 512,
});

const pocketbase = service("pocketbase", {
  source: github("8u9i/pocketbase-railway", { branch: "main" }),
  start: "/pb/entrypoint.sh",
  healthcheck: "/api/health",
  volumeMounts: {
    "/pb/pb_data": pbData,
  },
  env: {
    PORT: "8080",
    // Beginner-friendly defaults (see README). Replace with real credentials.
    PB_ADMIN_EMAIL: "admin@example.com",
    PB_ADMIN_PASSWORD: "changeme123",
    // Public URL for email links, OAuth2 redirects, file URLs, and the
    // dashboard "App URL". Auto-derived from Railway's public domain by
    // default; set a custom domain here when you attach one.
    PB_PUBLIC_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
    // Sealed secrets you set in the Railway dashboard / CLI stay preserved:
    PB_SKIP_ADMIN: preserve(),
  },
});

export default defineRailway(() =>
  project("pocketbase-railway", {
    resources: [pocketbase, pbData],
  })
);
