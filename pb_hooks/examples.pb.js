// PocketBase JS hooks - examples you can enable.
//
// Hooks let you run custom logic on requests, records, realtime, and more.
// Every .js file in pb_hooks/ is loaded when PocketBase starts.
// See: https://pocketbase.io/docs/js-overview/
//
// These are commented out by default so the template works out of the box.
// Uncomment the ones you want, redeploy, and they take effect.

/// <reference path="../pb_data/types.d.ts" />

// ---------------------------------------------------------------------------
// Example 1: a public status endpoint (no auth required).
// ---------------------------------------------------------------------------
// routerAdd("GET", "/api/hello", (c) => {
//   return c.json(200, { message: "Hello from PocketBase on Railway!" });
// });

// ---------------------------------------------------------------------------
// Example 2: log whenever a todo is created.
// ---------------------------------------------------------------------------
// onRecordAfterCreateRequest((e) => {
//   if (e.record.collection().name === "todos") {
//     console.log("New todo:", e.record.get("title"));
//   }
// }, "todos");

// ---------------------------------------------------------------------------
// Example 3: reject todos with a title shorter than 3 characters.
// ---------------------------------------------------------------------------
// onRecordBeforeCreateRequest((e) => {
//   const title = e.record.get("title");
//   if (typeof title === "string" && title.trim().length < 3) {
//     throw new BadRequestError("Title must be at least 3 characters.");
//   }
// }, "todos");
