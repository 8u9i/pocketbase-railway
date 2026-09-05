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
//
// Note: PocketBase runs each hook callback and cron job as a standalone
// program in a separate VM that only has the shared bindings
// ($app, $os, $security, $http). Module-scope functions are NOT visible
// inside callbacks, so every callback below is fully self-contained.

// Fire webhooks on record create.
onRecordAfterCreateSuccess((e) => {
  const disabled = $os.getenv("PB_WEBHOOKS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  const db = $app.db();
  const allWebhooks = arrayOf(new DynamicModel({
    id: "",
    url: "",
    events: "",
    secret: nullString(),
    enabled: 0,
    headers: nullString(),
    collection: nullString(),
  }));
  db.newQuery("SELECT * FROM webhooks WHERE enabled = 1").all(allWebhooks);

  for (const wh of allWebhooks) {
    const events = (wh.events || "").split(",").map((ev) => ev.trim());
    if (!events.includes("create") && !events.includes("*")) continue;
    if (wh.collection && wh.collection !== collection.name) continue;

    const payload = JSON.stringify({
      event: "create",
      collection: collection.name,
      record: e.record,
      timestamp: new Date().toISOString(),
    });

    const deliveryId = $security.randomStringWithAlphabet(
      15,
      "abcdefghijklmnopqrstuvwxyz0123456789"
    );

    db.newQuery(
      "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts) VALUES ({:id}, {:whId}, {:event}, {:payload}, 0)"
    )
      .bind({ id: deliveryId, whId: wh.id, event: "create", payload })
      .execute();

    const customHeaders = wh.headers ? JSON.parse(wh.headers || "{}") : {};
    const headers = {
      "Content-Type": "application/json",
      "X-PB-Webhook-Event": "create",
      "X-PB-Webhook-ID": wh.id,
      "X-PB-Delivery-ID": deliveryId,
      ...customHeaders,
    };

    if (wh.secret) {
      headers["X-PB-Signature"] = "sha256=" + $security.hs256(payload, wh.secret);
    }

    let response;
    try {
      response = $http.send({
        url: wh.url,
        method: "POST",
        headers: headers,
        body: payload,
        timeout: 30,
      });
    } catch (err) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
      continue;
    }

    const success = response.statusCode >= 200 && response.statusCode < 300;
    let responseBody = "";
    try {
      responseBody = toString(response.body, 1000);
    } catch (err) {}

    db.newQuery(
      "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
    )
      .bind({
        code: response.statusCode,
        body: responseBody,
        ok: success ? 1 : 0,
        id: deliveryId,
      })
      .execute();

    if (!success) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
    }
  }
});

// Fire webhooks on record update.
onRecordAfterUpdateSuccess((e) => {
  const disabled = $os.getenv("PB_WEBHOOKS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  const db = $app.db();
  const allWebhooks = arrayOf(new DynamicModel({
    id: "",
    url: "",
    events: "",
    secret: nullString(),
    enabled: 0,
    headers: nullString(),
    collection: nullString(),
  }));
  db.newQuery("SELECT * FROM webhooks WHERE enabled = 1").all(allWebhooks);

  for (const wh of allWebhooks) {
    const events = (wh.events || "").split(",").map((ev) => ev.trim());
    if (!events.includes("update") && !events.includes("*")) continue;
    if (wh.collection && wh.collection !== collection.name) continue;

    const payload = JSON.stringify({
      event: "update",
      collection: collection.name,
      record: e.record,
      timestamp: new Date().toISOString(),
    });

    const deliveryId = $security.randomStringWithAlphabet(
      15,
      "abcdefghijklmnopqrstuvwxyz0123456789"
    );

    db.newQuery(
      "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts) VALUES ({:id}, {:whId}, {:event}, {:payload}, 0)"
    )
      .bind({ id: deliveryId, whId: wh.id, event: "update", payload })
      .execute();

    const customHeaders = wh.headers ? JSON.parse(wh.headers || "{}") : {};
    const headers = {
      "Content-Type": "application/json",
      "X-PB-Webhook-Event": "update",
      "X-PB-Webhook-ID": wh.id,
      "X-PB-Delivery-ID": deliveryId,
      ...customHeaders,
    };

    if (wh.secret) {
      headers["X-PB-Signature"] = "sha256=" + $security.hs256(payload, wh.secret);
    }

    let response;
    try {
      response = $http.send({
        url: wh.url,
        method: "POST",
        headers: headers,
        body: payload,
        timeout: 30,
      });
    } catch (err) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
      continue;
    }

    const success = response.statusCode >= 200 && response.statusCode < 300;
    let responseBody = "";
    try {
      responseBody = toString(response.body, 1000);
    } catch (err) {}

    db.newQuery(
      "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
    )
      .bind({
        code: response.statusCode,
        body: responseBody,
        ok: success ? 1 : 0,
        id: deliveryId,
      })
      .execute();

    if (!success) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
    }
  }
});

// Fire webhooks on record delete.
onRecordAfterDeleteSuccess((e) => {
  const disabled = $os.getenv("PB_WEBHOOKS_DISABLED");
  if (disabled === "true" || disabled === "1") return;

  const collection = e.record.collection();
  if (!collection || collection.name.startsWith("_")) return;

  const db = $app.db();
  const allWebhooks = arrayOf(new DynamicModel({
    id: "",
    url: "",
    events: "",
    secret: nullString(),
    enabled: 0,
    headers: nullString(),
    collection: nullString(),
  }));
  db.newQuery("SELECT * FROM webhooks WHERE enabled = 1").all(allWebhooks);

  for (const wh of allWebhooks) {
    const events = (wh.events || "").split(",").map((ev) => ev.trim());
    if (!events.includes("delete") && !events.includes("*")) continue;
    if (wh.collection && wh.collection !== collection.name) continue;

    const payload = JSON.stringify({
      event: "delete",
      collection: collection.name,
      record: e.record,
      timestamp: new Date().toISOString(),
    });

    const deliveryId = $security.randomStringWithAlphabet(
      15,
      "abcdefghijklmnopqrstuvwxyz0123456789"
    );

    db.newQuery(
      "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts) VALUES ({:id}, {:whId}, {:event}, {:payload}, 0)"
    )
      .bind({ id: deliveryId, whId: wh.id, event: "delete", payload })
      .execute();

    const customHeaders = wh.headers ? JSON.parse(wh.headers || "{}") : {};
    const headers = {
      "Content-Type": "application/json",
      "X-PB-Webhook-Event": "delete",
      "X-PB-Webhook-ID": wh.id,
      "X-PB-Delivery-ID": deliveryId,
      ...customHeaders,
    };

    if (wh.secret) {
      headers["X-PB-Signature"] = "sha256=" + $security.hs256(payload, wh.secret);
    }

    let response;
    try {
      response = $http.send({
        url: wh.url,
        method: "POST",
        headers: headers,
        body: payload,
        timeout: 30,
      });
    } catch (err) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
      continue;
    }

    const success = response.statusCode >= 200 && response.statusCode < 300;
    let responseBody = "";
    try {
      responseBody = toString(response.body, 1000);
    } catch (err) {}

    db.newQuery(
      "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
    )
      .bind({
        code: response.statusCode,
        body: responseBody,
        ok: success ? 1 : 0,
        id: deliveryId,
      })
      .execute();

    if (!success) {
      const nextRetry = new Date(Date.now() + 5 * 1000);
      db.newQuery(
        "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = 1 WHERE id = {:id}"
      )
        .bind({ retry: nextRetry.toISOString(), id: deliveryId })
        .execute();
    }
  }
});

// Register cron for retry processing (every minute).
if ($os.getenv("PB_WEBHOOKS_DISABLED") !== "true" && $os.getenv("PB_WEBHOOKS_DISABLED") !== "1") {
  cronAdd("webhook-retries", "* * * * *", () => {
    const maxRetries = 5;
    const retryDelays = [5, 30, 120, 600, 3600];
    const db = $app.db();

    const pending = arrayOf(new DynamicModel({
      id: "",
      webhook_id: "",
      event: "",
      payload: "",
      status_code: nullInt(),
      success: 0,
      attempts: 0,
      next_retry_at: nullString(),
    }));
    db.newQuery(
      "SELECT id, webhook_id, event, payload, status_code, success, attempts, next_retry_at FROM webhook_deliveries WHERE success = 0 AND attempts < {:max} AND next_retry_at IS NOT NULL AND next_retry_at <= {:now}"
    )
      .bind({ max: maxRetries, now: new Date().toISOString() })
      .all(pending);

    for (const delivery of pending) {
      const webhook = new DynamicModel({
        id: "",
        url: "",
        events: "",
        secret: nullString(),
        enabled: 0,
        headers: nullString(),
        collection: nullString(),
      });
      try {
        db.newQuery("SELECT * FROM webhooks WHERE id = {:id}")
          .bind({ id: delivery.webhook_id })
          .one(webhook);
      } catch (err) {
        continue;
      }

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

      if (webhook.secret) {
        headers["X-PB-Signature"] = "sha256=" + $security.hs256(delivery.payload, webhook.secret);
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
      } catch (err) {
        if (delivery.attempts < maxRetries) {
          const delay = retryDelays[Math.min(delivery.attempts, retryDelays.length - 1)];
          const nextRetry = new Date(Date.now() + delay * 1000);
          db.newQuery(
            "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = {:attempt} WHERE id = {:id}"
          )
            .bind({ retry: nextRetry.toISOString(), attempt: delivery.attempts + 1, id: delivery.id })
            .execute();
        }
        continue;
      }

      const success = response.statusCode >= 200 && response.statusCode < 300;
      let responseBody = "";
      try {
        responseBody = toString(response.body, 1000);
      } catch (err) {}

      db.newQuery(
        "UPDATE webhook_deliveries SET status_code = {:code}, response_body = {:body}, success = {:ok}, attempts = attempts + 1 WHERE id = {:id}"
      )
        .bind({
          code: response.statusCode,
          body: responseBody,
          ok: success ? 1 : 0,
          id: delivery.id,
        })
        .execute();

      if (!success && delivery.attempts < maxRetries) {
        const delay = retryDelays[Math.min(delivery.attempts, retryDelays.length - 1)];
        const nextRetry = new Date(Date.now() + delay * 1000);
        db.newQuery(
          "UPDATE webhook_deliveries SET next_retry_at = {:retry}, attempts = {:attempt} WHERE id = {:id}"
        )
          .bind({ retry: nextRetry.toISOString(), attempt: delivery.attempts + 1, id: delivery.id })
          .execute();
      }
    }
  });
}
