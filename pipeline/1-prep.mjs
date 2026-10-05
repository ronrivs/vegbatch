/**
 * Stage 1 — prep.
 *
 * Source photos are 4032px and ~2 MB each. They read fine at 1600px, which is
 * ~6x cheaper to send and well inside the model's own downscale threshold.
 * Also fixes EXIF rotation and fingerprints each file so a re-shoot of the
 * same page can be spotted later.
 *
 *   node 1-prep.mjs [--limit 20] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { SOURCE, PREPPED, WORK, ensureDirs, readJson, writeJson, args } from "./lib/config.mjs";

const MANIFEST = path.join(WORK, "manifest.json");
const MAX_EDGE = 1600;

const { limit, force } = args();
ensureDirs();

const sources = fs
  .readdirSync(SOURCE)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort();

const slice = limit ? sources.slice(0, limit) : sources;
const existing = force ? [] : readJson(MANIFEST, []);
const byName = new Map(existing.map((e) => [e.source, e]));

console.log(`prep: ${slice.length} of ${sources.length} photos -> ${MAX_EDGE}px`);

const manifest = [];
for (const [i, source] of slice.entries()) {
  const prepped = source.replace(/\.jpe?g$/i, ".jpg");
  const outPath = path.join(PREPPED, prepped);

  if (byName.has(source) && fs.existsSync(outPath)) {
    manifest.push(byName.get(source));
    continue;
  }

  const buffer = await sharp(path.join(SOURCE, source))
    .rotate() // honour EXIF orientation
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  fs.writeFileSync(outPath, buffer);
  const meta = await sharp(buffer).metadata();

  manifest.push({
    // seq is the chronological position — page grouping leans on it heavily
    seq: sources.indexOf(source),
    source,
    prepped,
    width: meta.width,
    height: meta.height,
    orientation: meta.width > meta.height ? "landscape" : "portrait",
    bytes: buffer.length,
    sha1: crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 12),
  });

  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${slice.length}`);
}

manifest.sort((a, b) => a.seq - b.seq);
writeJson(MANIFEST, manifest);

const mb = manifest.reduce((s, m) => s + m.bytes, 0) / 1024 / 1024;
console.log(`prep: wrote ${manifest.length} images (${mb.toFixed(1)} MB) -> ${MANIFEST}`);
