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
//     collection: "posts",
//     headers: {"X-Custom": "value"}
//   }
//
// Config: set PB_WEBHOOKS_DISABLED=true to disable.

const MAX_RETRIES = 5;
const RETRY_DELAYS = [5, 30, 120, 600, 3600]; // seconds

const WEBHOOKS_DISABLED = (() => {
  const v = $os.getenv("PB_WEBHOOKS_DISABLED");
  return v === "true" || v === "1";
})();

// Find webhooks that match the event and collection.
function findMatchingWebhooks(eventName, collectionName) {
  const allWebhooks = $app
    .db()
    .newQuery("SELECT * FROM webhooks WHERE enabled = 1")
    .all();

  return allWebhooks.filter((wh) => {
    const events = (wh.events || "").split(",").map((e) => e.trim());
    if (!events.includes(eventName) && !events.includes("*")) return false;
    if (wh.collection && wh.collection !== collectionName) return false;
    return true;
  });
}

// Compute HMAC-SHA256 signature for a payload.
function signPayload(payload, secret) {
  if (!secret) return "";
  return "sha256=" + $security.hs256(payload, secret);
}

// Schedule a retry for a failed delivery.
function scheduleRetry(deliveryId, attemptCount) {
  if (attemptCount >= MAX_RETRIES) return;

  const delay = RETRY_DELAYS[Math.min(attemptCount, RETRY_DELAYS.length - 1)];
  const nextRetry = new Date(Date.now() + delay * 1000);

  $app
    .db()
    .newQuery("UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = {:attempt} WHERE id = {:id}")
    .bind({ retry: nextRetry.toISOString(), attempt: attemptCount + 1, id: deliveryId })
    .execute();
}

// Dispatch a webhook and log the delivery.
function dispatchWebhook(webhook, eventName, record) {
  const db = $app.db();

  const payload = JSON.stringify({
    event: eventName,
    collection: record.collection().name,
    record: record,
    timestamp: new Date().toISOString(),
  });

  const deliveryId = $security.randomStringWithAlphabet(
    15,
    "abcdefghijklmnopqrstuvwxyz0123456789"
  );

  db.newQuery(
    "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts) VALUES ({:id}, {:whId}, {:event}, {:payload}, 0)"
  )
    .bind({ id: deliveryId, whId: webhook.id, event: eventName, payload })
    .execute();

  const customHeaders = webhook.headers ? JSON.parse(webhook.headers || "{}") : {};
  const headers = {
    "Content-Type": "application/json",
    "X-PB-Webhook-Event": eventName,
    "X-PB-Webhook-ID": webhook.id,
    "X-PB-Delivery-ID": deliveryId,
    ...customHeaders,
  };

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
      timeout: 30,
    });
  } catch (e) {
    scheduleRetry(deliveryId, 0);
    return;
  }

  const success = response.statusCode >= 200 && response.statusCode < 300;
  const responseBody = typeof response.body === "string" ? response.body : "";

  db.newQuery(
    "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
  )
    .bind({
      code: response.statusCode,
      body: responseBody.substring(0, 1000),
      ok: success ? 1 : 0,
      id: deliveryId,
    })
    .execute();

  if (!success) {
    scheduleRetry(deliveryId, 0);
  }
}

// Process pending retries (called by cron).
function processRetries() {
  const db = $app.db();

  const pending = db
    .newQuery(
      "SELECT * FROM webhook_deliveries WHERE success = 0 AND attempts < {:max} AND next_retry_at IS NOT NULL AND next_retry_at <= {:now}"
    )
    .bind({ max: MAX_RETRIES, now: new Date().toISOString() })
    .all();

  for (const delivery of pending) {
    const webhook = db
      .newQuery("SELECT * FROM webhooks WHERE id = {:id}")
      .bind({ id: delivery.webhook_id })
      .one();

    if (!webhook || !webhook.enabled) continue;

    const customHeaders = webhook.headers ? JSON.parse(webhook.headers || "{}") : {};
    const headers = {
      "Content-Type": "application/json",
      "X-PB-Webhook-Event": delivery.event,
      "X-PB-Webhook-ID": webhook.id,
      "X-PB-Delivery-ID": delivery.id,
      "X-PB-Retry-Attempt": String(delivery.attempts),
      ...customHeaders,
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
    const responseBody = typeof response.body === "string" ? response.body : "";

    db.newQuery(
      "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
    )
      .bind({
        code: response.statusCode,
        body: responseBody.substring(0, 1000),
        ok: success ? 1 : 0,
        id: delivery.id,
      })
      .execute();

    if (!success) {
      scheduleRetry(delivery.id, delivery.attempts);
    }
  }
}

// Register cron for retry processing (every minute).
if (!WEBHOOKS_DISABLED) {
  cronAdd("webhook-retries", "* * * * *", () => {
    processRetries();
  });
}

// Fire webhooks on record events.
function fireEvent(eventName, e) {
  if (WEBHOOKS_DISABLED) return;
  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  const webhooks = findMatchingWebhooks(eventName, collection.name);
  for (const wh of webhooks) {
    dispatchWebhook(wh, eventName, e.record);
  }
}

onRecordAfterCreateSuccess((e) => fireEvent("create", e));
onRecordAfterUpdateSuccess((e) => fireEvent("update", e));
onRecordAfterDeleteSuccess((e) => fireEvent("delete", e));
