/**
 * Review server — the human gate on the dataset.
 *
 * Deliberately a tiny dependency-free static server + two JSON endpoints
 * rather than a framework: it runs on Ron's PC, it has one user at a time,
 * and it must still work in a year with no npm install.
 *
 *   node review/server.mjs   ->   http://localhost:4173
 *
 * Edits are written straight back to data/recipes.json. The original
 * extraction is preserved in data/recipes.raw.json on first edit, so a bad
 * review pass is always recoverable.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, PREPPED } from "../lib/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.join(DATA, "recipes.json");
const BACKUP = path.join(DATA, "recipes.raw.json");
const PORT = 4173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/recipes" && req.method === "GET") {
    if (!fs.existsSync(RECIPES)) return send(res, 200, "[]");
    return send(res, 200, fs.readFileSync(RECIPES, "utf8"));
  }

  // Save one recipe. Whole-file rewrite is fine at this size and keeps the
  // on-disk file the single source of truth after every keystroke-batch.
  if (url.pathname === "/api/recipe" && req.method === "PUT") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const incoming = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    const all = JSON.parse(fs.readFileSync(RECIPES, "utf8"));
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, JSON.stringify(all, null, 2) + "\n", "utf8");

    const i = all.findIndex((r) => r.id === incoming.id);
    if (i === -1) return send(res, 404, JSON.stringify({ error: "unknown id" }));
    all[i] = incoming;
    fs.writeFileSync(RECIPES, JSON.stringify(all, null, 2) + "\n", "utf8");
    return send(res, 200, JSON.stringify({ ok: true, reviewed: all.filter((r) => r.reviewed).length }));
  }

  if (url.pathname.startsWith("/photo/")) {
    const name = path.basename(decodeURIComponent(url.pathname.slice("/photo/".length)));
    const file = path.join(PREPPED, name);
    if (!fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=3600" });
    return fs.createReadStream(file).pipe(res);
  }

  const file = path.join(here, url.pathname === "/" ? "index.html" : path.basename(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? "text/plain");
  }
  send(res, 404, "not found", "text/plain");
});

server.listen(PORT, () => {
  const n = fs.existsSync(RECIPES) ? JSON.parse(fs.readFileSync(RECIPES, "utf8")).length : 0;
  console.log(`review: ${n} recipes -> http://localhost:${PORT}`);
});
