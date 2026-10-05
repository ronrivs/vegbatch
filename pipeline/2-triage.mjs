/**
 * Stage 2 — triage.
 *
 * One cheap pass over every photo to answer: what is this, does it start a
 * recipe or continue one, is it legible, does it contain meat. Grouping
 * (stage 3) runs off this, so the question that matters most here is
 * `continues_previous`.
 *
 * Images go out in small batches WITH the trailing image of the previous
 * batch as context, so the model can judge continuation across a batch
 * boundary the same way it does inside one.
 *
 *   node 2-triage.mjs [--limit 20] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import {
  PREPPED, WORK, ensureDirs, readJson, writeJson, args, askJson, imageBlock, costOf, mapPool, requireSpendApproval } from "./lib/config.mjs";

const MANIFEST = path.join(WORK, "manifest.json");
const OUT = path.join(WORK, "triage.json");
const BATCH = 8;

const SYSTEM = `You are cataloguing photographs of a household's personal recipe
collection. The photos are in the order they were taken and the pages were
photographed in order, so consecutive photos are usually related.

The collection is a mix of pages printed from food blogs and handwritten index
cards. Recipes sometimes run over two or more photos, and a continuation page
often carries no title at all — it just starts mid-list or mid-step. Index
cards are sometimes photographed front and back.

Report only what you can actually see. If a field is not determinable from the
image, say so with null or "unknown" rather than guessing. Never invent a title
that is not written on the page.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "prepped", "doc_type", "title", "page_role", "continues_previous",
          "has_ingredients", "has_instructions", "contains_meat", "meat_items",
          "legibility", "notes",
        ],
        properties: {
          prepped: { type: "string", description: "the filename exactly as labelled" },
          doc_type: {
            type: "string",
            enum: ["printed_recipe", "handwritten_card", "cookbook_page", "other", "unreadable"],
          },
          title: {
            type: ["string", "null"],
            description: "recipe title as written on the page; null if none is visible",
          },
          page_role: {
            type: "string",
            enum: ["single", "first", "continuation", "card_back", "unknown"],
            description: "'single' = the whole recipe is on this one page",
          },
          continues_previous: {
            type: "boolean",
            description: "true if this page carries on the recipe from the previous photo",
          },
          has_ingredients: { type: "boolean" },
          has_instructions: { type: "boolean" },
          contains_meat: {
            type: "boolean",
            description: "true only for actual meat, poultry or fish in the ingredients",
          },
          meat_items: { type: "array", items: { type: "string" } },
          legibility: { type: "string", enum: ["good", "fair", "poor"] },
          notes: {
            type: "string",
            description:
              "anything a human reviewer should know: bleed-through from the sheet underneath, cropped edges, crossed-out text, marginalia",
          },
        },
      },
    },
  },
};

requireSpendApproval("2-triage");
const { limit, force, concurrency } = args();
ensureDirs();

const manifest = readJson(MANIFEST, []);
if (!manifest.length) throw new Error("no manifest — run 1-prep.mjs first");

const todo = limit ? manifest.slice(0, limit) : manifest;
const done = force ? new Map() : new Map(readJson(OUT, []).map((r) => [r.prepped, r]));

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) {
  batches.push({ start: i, items: todo.slice(i, i + BATCH) });
}

const results = [];
const usages = [];
let finished = 0;

console.log(`triage: ${todo.length} photos in ${batches.length} batches, concurrency ${concurrency}`);

const settled = await mapPool(batches, concurrency, async ({ start: i, items: batch }) => {
  if (batch.every((m) => done.has(m.prepped))) {
    return batch.map((m) => done.get(m.prepped));
  }

  // one image of lead-in context so continuation is judgeable at the seam
  const lead = i > 0 ? todo[i - 1] : null;
  const content = [];

  if (lead) {
    content.push({
      type: "text",
      text: `CONTEXT — the photo immediately before this batch (${lead.prepped}). Do not report on it; it is here only so you can judge whether the first image below continues it.`,
    });
    content.push(imageBlock(fs.readFileSync(path.join(PREPPED, lead.prepped)).toString("base64")));
  }

  content.push({
    type: "text",
    text: `Catalogue the following ${batch.length} photos, in order. Return one entry per photo, using the filename given above each image.`,
  });

  for (const m of batch) {
    content.push({ type: "text", text: `--- ${m.prepped} (photo ${m.seq + 1} of ${manifest.length}) ---` });
    content.push(imageBlock(fs.readFileSync(path.join(PREPPED, m.prepped)).toString("base64")));
  }

  const { data, usage } = await askJson({ system: SYSTEM, content, schema: SCHEMA, effort: "medium" });
  usages.push(usage);

  const byName = new Map(data.images.map((r) => [r.prepped, r]));
  const rows = [];
  for (const m of batch) {
    const row = byName.get(m.prepped);
    if (!row) {
      console.warn(`  !! no triage row returned for ${m.prepped}`);
      continue;
    }
    rows.push({ seq: m.seq, ...row });
  }
  console.log(`  [${String(++finished).padStart(3)}/${batches.length}] photos ${i + 1}-${i + batch.length}`);
  return rows;
});

const failures = [];
for (const [i, r] of settled.entries()) {
  if (r.ok) results.push(...r.value);
  else failures.push({ batch: i, error: r.error.message });
}

results.sort((a, b) => a.seq - b.seq);
writeJson(OUT, results);
if (failures.length) {
  console.log(`\n  ${failures.length} batches FAILED (re-run to retry):`);
  for (const f of failures) console.log(`    batch ${f.batch}: ${f.error}`);
}

const meat = results.filter((r) => r.contains_meat);
const poor = results.filter((r) => r.legibility === "poor");
console.log(`\ntriage: ${results.length} photos -> ${OUT}`);
console.log(`  starts: ${results.filter((r) => r.page_role === "single" || r.page_role === "first").length}`);
console.log(`  continuations: ${results.filter((r) => r.continues_previous).length}`);
console.log(`  with meat: ${meat.length}${meat.length ? " (" + meat.map((r) => r.title ?? r.prepped).join(", ") + ")" : ""}`);
console.log(`  poor legibility: ${poor.length}`);
console.log(`  est. cost so far: $${costOf(usages).toFixed(2)}`);
