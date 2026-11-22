// Runs worker.js locally on http://localhost:8787 using .dev.vars.
// Production uses `npx wrangler deploy` instead.
import http from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";

// Local stand-in for Cloudflare D1.
const sqlite = new DatabaseSync(process.env.DB_FILE || "dev.sqlite");
sqlite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const DB_ADAPTER = {
  all: async (sql, ...p) => sqlite.prepare(sql).all(...p),
  first: async (sql, ...p) => sqlite.prepare(sql).get(...p) ?? null,
  run: async (sql, ...p) => sqlite.prepare(sql).run(...p),
};

const env = Object.fromEntries(
  readFileSync(new URL("./.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

env.DB_ADAPTER = DB_ADAPTER;

const PORT = Number(process.env.PORT || 8787);

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const started = Date.now();
    const response = await worker.fetch(request, env);
    const text = await response.text();
    console.log(`${req.method} ${req.url} ${response.status} ${Date.now() - started}ms ${text}`);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(text);
  })
  .listen(PORT, () => console.log(`relay dev server on http://localhost:${PORT}`));
