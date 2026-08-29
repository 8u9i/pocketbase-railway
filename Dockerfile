# PocketBase on Railway
# Single ~12MB Go binary: SQLite database, auth, file storage, realtime, admin UI.
#
# Bump PB_VERSION to the latest release: https://github.com/pocketbase/pocketbase/releases
ARG PB_VERSION=0.40.1

FROM alpine:3.20

ARG PB_VERSION
ARG TARGETARCH

# ca-certificates: required for OAuth and outbound HTTPS.
# curl: used by the Docker HEALTHCHECK below.
RUN apk add --no-cache ca-certificates curl

# Download the release matching the build architecture (amd64 / arm64).
ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip

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
