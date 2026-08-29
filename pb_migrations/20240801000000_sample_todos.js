// PocketBase JS migration - creates a sample "todos" collection and seeds it.
//
// How it works: PocketBase runs every file in pb_migrations/ in lexicographic
// order and records the filename in _migrations, so each migration runs exactly
// once (even across redeploys, because pb_data persists on the volume).
//
// Edit or delete this file to customize. See:
//   https://pocketbase.io/docs/js-migrations/
//   https://pocketbase.io/docs/collections/

/// <reference path="../pb_data/types.d.ts" />

import { Collection } from "pocketbase";

// 20240801000000 is a timestamp-based id; name your files
// <YYYYMMDDHHMMSS>_<description>.js so they run in order.
migrate(
  (app) => {
    const collection = new Collection({
      type: "base",
      name: "todos",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        {
          name: "title",
          type: "text",
          required: true,
          max: 200,
        },
        {
          name: "done",
          type: "bool",
        },
      ],
    });

    app.save(collection);

    // Seed a few rows so the API and admin UI have something to show on first boot.
    const todos = app.findCollectionByNameOrId("todos");
    app.save(
      app.createRecord(todos, {
        title: "Deploy PocketBase to Railway",
        done: true,
      })
    );
    app.save(
      app.createRecord(todos, {
        title: "Build something without a backend",
        done: false,
      })
    );
  },
  (app) => {
    // Rollback: drop the collection (and its records) if the migration is reverted.
    const todos = app.findCollectionByNameOrId("todos");
    if (todos) {
      app.delete(todos);
    }
  }
);
