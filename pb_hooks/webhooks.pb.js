// Webhook engine - dispatches HTTP callbacks on record events.
//
// This hook fires configured webhooks whenever records are created, updated,
// or deleted. It supports:
//   - Per-collection or global webhooks
//   - HMAC-SHA256 signature verification
//   - Custom headers
//   - Delivery logging
//   - Automatic retry with exponential backoff (via cron)
//
// Configure webhooks by inserting records into the `webhooks` table:
//   {
//     url: "https://example.com/webhook",
//     events: "create,update,delete",
//     secret: "your-signing-secret",
//     collection: "posts",  // optional: only fire for this collection
//     headers: {"X-Custom": "value"}  // optional: additional headers
//   }
//
// Config: set PB_WEBHOOKS_DISABLED=true to disable.

const MAX_RETRIES = 5;
const RETRY_DELAYS = [5, 30, 120, 600, 3600]; // seconds: 5s, 30s, 2m, 10m, 1h

// Find webhooks that match the event and collection
function findMatchingWebhooks(eventName, collectionName) {
  const db = app.db();
  const allWebhooks = db
    .newQuery("SELECT * FROM webhooks WHERE enabled = 1")
    .all();

  return allWebhooks.filter((wh) => {
    // Check event match
    const events = (wh.events || "").split(",").map((e) => e.trim());
    if (!events.includes(eventName) && !events.includes("*")) return false;

    // Check collection match (empty = all collections)
    if (wh.collection && wh.collection !== collectionName) return false;

    return true;
  });
}

// Compute HMAC-SHA256 signature
function signPayload(payload, secret) {
  if (!secret) return "";
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return "sha256=" + hmac.digest("hex");
}

// Dispatch a webhook
function dispatchWebhook(webhook, eventName, record) {
  const db = app.db();
  const payload = JSON.stringify({
    event: eventName,
    collection: record.collection()?.name,
    record: record,
    timestamp: new Date().toISOString(),
  });

  const deliveryId = $security.randomStringWithAlphabet(
    "abcdefghijklmnopqrstuvwxyz0123456789",
    15
  );

  // Create delivery log entry
  db.newQuery(
    "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts) VALUES ({:id}, {:whId}, {:event}, {:payload}, 0)"
  )
    .bind({ id: deliveryId, whId: webhook.id, event: eventName, payload })
    .execute();

  // Attempt delivery
  const headers = {
    "Content-Type": "application/json",
    "X-PB-Webhook-Event": eventName,
    "X-PB-Webhook-ID": webhook.id,
    "X-PB-Delivery-ID": deliveryId,
    ...(webhook.headers ? JSON.parse(webhook.headers || "{}") : {}),
  };

  // Add signature if secret is configured
  const signature = signPayload(payload, webhook.secret);
  if (signature) {
    headers["X-PB-Signature"] = signature;
  }

  let response;
  try {
    response = $http.send({
      url: webhook.url,
      method: "POST",
      headers: headers,
      body: payload,
      timeout: 30, // seconds
    });
  } catch (e) {
    // Network error - schedule retry
    scheduleRetry(deliveryId, 0);
    return;
  }

  // Update delivery log
  const success = response.statusCode >= 200 && response.statusCode < 300;
  db.newQuery(
    "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
  )
    .bind({
      code: response.statusCode,
      body: (response.body || "").substring(0, 1000), // truncate long responses
      ok: success ? 1 : 0,
      id: deliveryId,
    })
    .execute();

  // Schedule retry on failure
  if (!success) {
    scheduleRetry(deliveryId, 0);
  }
}

// Schedule a retry for a failed delivery
function scheduleRetry(deliveryId, attemptCount) {
  if (attemptCount >= MAX_RETRIES) return;

  const delay = RETRY_DELAYS[Math.min(attemptCount, RETRY_DELAYS.length - 1)];
  const nextRetry = new Date(Date.now() + delay * 1000);

  app
    .db()
    .newQuery("UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = {:attempt} WHERE id = {:id}")
    .bind({ retry: nextRetry.toISOString(), attempt: attemptCount + 1, id: deliveryId })
    .execute();
}

// Process pending retries (called by cron)
function processRetries() {
  if (env.PB_WEBHOOKS_DISABLED === "true" || env.PB_WEBHOOKS_DISABLED === "1") return;

  const db = app.db();
  const pending = db
    .newQuery(
      "SELECT * FROM webhook_deliveries WHERE success = 0 AND attempts < {:max} AND next_retry_at <= {:now}"
    )
    .bind({ max: MAX_RETRIES, now: new Date().toISOString() })
    .all();

  for (const delivery of pending) {
    const webhook = db
      .newQuery("SELECT * FROM webhooks WHERE id = {:id}")
      .bind({ id: delivery.webhook_id })
      .one();

    if (!webhook || !webhook.enabled) continue;

    const headers = {
      "Content-Type": "application/json",
      "X-PB-Webhook-Event": delivery.event,
      "X-PB-Webhook-ID": webhook.id,
      "X-PB-Delivery-ID": delivery.id,
      "X-PB-Retry-Attempt": String(delivery.attempts),
      ...(webhook.headers ? JSON.parse(webhook.headers || "{}") : {}),
    };

    const signature = signPayload(delivery.payload, webhook.secret);
    if (signature) {
      headers["X-PB-Signature"] = signature;
    }

    let response;
    try {
      response = $http.send({
        url: webhook.url,
        method: "POST",
        headers: headers,
        body: delivery.payload,
        timeout: 30,
      });
    } catch (e) {
      scheduleRetry(delivery.id, delivery.attempts);
      continue;
    }

    const success = response.statusCode >= 200 && response.statusCode < 300;
    db.newQuery(
      "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
    )
      .bind({
        code: response.statusCode,
        body: (response.body || "").substring(0, 1000),
        ok: success ? 1 : 0,
        id: delivery.id,
      })
      .execute();

    if (!success) {
      scheduleRetry(delivery.id, delivery.attempts);
    }
  }
}

// Register cron for retry processing (every minute)
if (env.PB_WEBHOOKS_DISABLED !== "true" && env.PB_WEBHOOKS_DISABLED !== "1") {
  $app.cronAdd("webhook-retries", "* * * * *", () => {
    processRetries();
  });
}

// Fire webhooks on record events
function fireEvent(eventName, e) {
  if (env.PB_WEBHOOKS_DISABLED === "true" || env.PB_WEBHOOKS_DISABLED === "1") return;
  if (!e.collection || e.collection.name.startsWith("_")) return;

  const webhooks = findMatchingWebhooks(eventName, e.collection.name);
  for (const wh of webhooks) {
    dispatchWebhook(wh, eventName, e.record);
  }
}

onRecordAfterCreateRequest((e) => fireEvent("create", e));
onRecordAfterUpdateSuccess((e) => fireEvent("update", e));
onRecordAfterDeleteSuccess((e) => fireEvent("delete", e));
