/**
 * Preview the built site locally. Static files only — the same thing
 * Cloudflare Pages will serve.
 *
 *   node serve-site.mjs   ->   http://localhost:4174
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PROJECT } from "./lib/config.mjs";

const ROOT = path.join(PROJECT, "site");
const PORT = 4174;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

if (!fs.existsSync(ROOT)) {
  console.error("No site/ yet — run: node build-site.mjs");
  process.exit(1);
}

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  // no directory traversal out of site/
  const file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  let target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;

  // Mirror Cloudflare Pages: _redirects sends the two app-only routes to the
  // shell. Without this the preview 404s where production would serve.
  if (!fs.existsSync(target) && /^\/(plan|staples)\/?$/.test(url)) {
    target = path.join(ROOT, "index.html");
  }

  if (!target.startsWith(ROOT) || !fs.existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, () => console.log(`site preview -> http://localhost:${PORT}`));
