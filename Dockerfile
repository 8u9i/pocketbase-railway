# PocketBase on Railway - custom build with vec1 vector search.
#
# Two stages:
#   1. build - compiles the PocketBase Go binary with the ncruces driver and
#      the vec1 vector extension baked in (no CGO, pure Go). See main.go.
#   2. run   - the same slim Alpine image as the stock template, but running
#      OUR binary instead of the downloaded release.
#
# Everything stays one service: SQLite data, collections, hooks, migrations,
# admin UI, realtime, file storage - plus vector search.

# --- Build stage ------------------------------------------------------------
# Go 1.27 required by PocketBase v0.40.1 (see go.mod).
FROM golang:1.27-alpine AS build

WORKDIR /src

# go.mod first for better layer caching.
COPY go.mod ./
RUN go mod download

COPY main.go ./
# -tags no_default_driver excludes PocketBase's modernc.org/sqlite driver;
# the ncruces driver (renamed to "sqlite" via ldflags) takes its place.
# -trimpath keeps the binary reproducible/small.
RUN CGO_ENABLED=0 go build \
    -tags no_default_driver \
    -ldflags "-s -w -X github.com/ncruces/go-sqlite3/driver.driverName=sqlite" \
    -trimpath \
    -o /out/pocketbase .

# --- Run stage --------------------------------------------------------------
FROM alpine:3.20

# ca-certificates: required for OAuth and outbound HTTPS.
# curl: used by the Docker HEALTHCHECK below.
RUN apk add --no-cache ca-certificates curl

COPY --from=build /out/pocketbase /pb/pocketbase

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY entrypoint.sh /pb/entrypoint.sh
RUN chmod +x /pb/entrypoint.sh

WORKDIR /pb
ENV PB_DATA_DIR=/pb/pb_data

# Railway injects PORT (default 8080); PocketBase serves HTTP on it.
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=10 \
  CMD curl -fsS http://127.0.0.1:${PORT:-8080}/api/health >/dev/null || exit 1

ENTRYPOINT ["/pb/entrypoint.sh"]
