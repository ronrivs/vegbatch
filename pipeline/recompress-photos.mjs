/**
 * Shrink photos that were uploaded before the browser started doing it.
 *
 * The client now bounds uploads at 1600px / JPEG 0.82, but anything already
 * in the bucket went up at full camera resolution — the first one was 2.9 MB
 * for an image displayed a few hundred pixels wide.
 *
 * Rewrites each object **in place**, so no database row changes and no link
 * anywhere breaks. Originals are copied to work/photo-backup/ first: this
 * edits real user data, and an irreversible optimisation is not an
 * optimisation.
 *
 * Local sharp, service-role storage access, no API spend.
 *
 *   node recompress-photos.mjs --dry     # report only
 *   node recompress-photos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PROJECT } from "./lib/config.mjs";

const MAX_EDGE = 1600;
const QUALITY = 82;
const WORTH_IT = 1.15;   // skip unless it saves at least 15%

const dry = process.argv.includes("--dry");
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(PROJECT, ".env"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const URL_ = env.SUPABASE_URL, SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const auth = { apikey: SVC, Authorization: `Bearer ${SVC}` };
const BACKUP = path.join(PROJECT, "work", "photo-backup");

const kb = (n) => `${Math.round(n / 1024)} KB`;

const rows = await (await fetch(
  `${URL_}/rest/v1/recipe_photos?select=id,recipe_id,storage_path`, { headers: auth })).json();
if (!Array.isArray(rows)) throw new Error(`could not list photos: ${JSON.stringify(rows)}`);

console.log(`\n${rows.length} photo(s)${dry ? " — dry run" : ""}\n`);
let saved = 0, done = 0;

for (const row of rows) {
  const url = `${URL_}/storage/v1/object/photos/${row.storage_path}`;
  // Cache-bust the READ as well as trusting the metadata on write-back. The
  // CDN served the pre-rewrite copy, so a second run re-read the old 2.9 MB
  // original, decided it still needed shrinking, and re-encoded it. Left
  // alone that is a slow quality grinder: every run would recompress an
  // already-compressed JPEG.
  const res = await fetch(`${url}?t=${Date.now()}`, { headers: auth });
  if (!res.ok) { console.log(`  ${row.recipe_id}  SKIP — storage returned ${res.status}`); continue; }
  const original = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(original).metadata();
  // .rotate() with no argument applies the EXIF orientation and then strips
  // it — without it a portrait photo comes out on its side once the tag is
  // gone, which is the same trap the browser side has.
  const shrunk = await sharp(original)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer();

  const gain = original.length / shrunk.length;
  const label = `${row.recipe_id}  ${meta.width}x${meta.height} ${kb(original.length)}`;
  if (gain < WORTH_IT) { console.log(`  ${label} -> already lean, left alone`); continue; }

  const after = await sharp(shrunk).metadata();
  console.log(`  ${label} -> ${after.width}x${after.height} ${kb(shrunk.length)}  (${gain.toFixed(1)}x smaller)`);
  if (dry) { saved += original.length - shrunk.length; continue; }

  // keep the original before overwriting it
  const backup = path.join(BACKUP, row.storage_path);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, original);

  const put = await fetch(url, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: shrunk,
  });
  if (!put.ok) { console.log(`     FAILED to write back: ${put.status} ${(await put.text()).slice(0, 120)}`); continue; }

  // Read it back rather than trusting the 200 — but ask the metadata API,
  // not the object URL. Storage GETs go through a CDN that happily served
  // the pre-write copy, which made a successful rewrite look like a failed
  // one. The list endpoint reads the row, so it cannot be stale.
  const dir = row.storage_path.slice(0, row.storage_path.lastIndexOf("/"));
  const name = row.storage_path.slice(dir.length + 1);
  const listed = await (await fetch(`${URL_}/storage/v1/object/list/photos`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: dir, limit: 100 }),
  })).json();
  const now = (Array.isArray(listed) ? listed : []).find((f) => f.name === name)?.metadata?.size ?? 0;
  if (Math.abs(now - shrunk.length) > 64) {
    console.log(`     WARNING: stored size is ${now}B, expected ${shrunk.length}B — left the backup in place`);
    continue;
  }
  saved += original.length - shrunk.length;
  done++;
}

console.log(`\n${dry ? "would save" : `rewrote ${done}, saved`} ${kb(saved)}`);
if (!dry && done) console.log(`originals kept in work/photo-backup/`);
