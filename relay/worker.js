// The Couple server: pairs two cats and passes notes, nudges and reminders
// between them. Free, and it never sees window titles or any AI key —
// focus mode talks to TypeSafe directly from each computer.

import * as store from "./store.js";

// Every route takes JSON. Pairing is protected by the one-use code;
// afterwards each computer identifies itself with its device id.
const COUPLE_ROUTES = {
  "/pair/start": (db, body) => store.startPair(db, body),
  "/pair/join": (db, body) => store.joinPair(db, body),
  "/sync": (db, body) => store.sync(db, body),
  "/send": (db, body) => store.send(db, body),
  "/reminder/add": (db, body) => store.addReminder(db, body),
  "/reminder/list": (db, body) => store.listReminders(db, body),
  "/reminder/delete": (db, body) => store.deleteReminder(db, body),
  "/pair/leave": (db, body) => store.leavePair(db, body),
};

// D1 (production) behind the same tiny interface the dev server uses.
const d1 = (DB) => ({
  all: (sql, ...p) => DB.prepare(sql).bind(...p).all().then((r) => r.results ?? []),
  first: (sql, ...p) => DB.prepare(sql).bind(...p).first(),
  run: (sql, ...p) => DB.prepare(sql).bind(...p).run(),
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "not_found" }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }

    const couple = COUPLE_ROUTES[url.pathname];
    if (!couple) return json({ error: "not_found" }, 404);

    const db = env.DB_ADAPTER || d1(env.DB);
    const result = await couple(db, body);
    return json(result, result?.error ? 400 : 200);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
