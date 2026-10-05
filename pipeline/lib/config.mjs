import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT = path.resolve(here, "..", "..");
export const SOURCE = path.join(PROJECT, "source");
export const WORK = path.join(PROJECT, "work");
export const PREPPED = path.join(WORK, "prepped");
export const DATA = path.join(PROJECT, "data");

// The Anthropic key already lives in the hub's .env; don't duplicate secrets.
// A local pipeline/.env wins if present.
const HUB_ENV = path.resolve(PROJECT, "..", "hub", ".env");
dotenv.config({ path: path.join(here, "..", ".env"), quiet: true });
if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(HUB_ENV)) {
  dotenv.config({ path: HUB_ENV, quiet: true });
}

export const MODEL = "claude-opus-5";

export const client = new Anthropic();

/**
 * Paid-API guard.
 *
 * The bulk extraction is done and cost $30.24 of real money on Ron's account.
 * Everyday work — review, grocery lists, staples, adding a recipe — is free
 * and must stay that way. Any stage that calls the API now has to be asked
 * for explicitly, so it can't happen by reflex or by a stray `--force`.
 *
 *   node 4-extract.mjs --allow-api-spend       (or VEGBATCH_ALLOW_API_SPEND=1)
 */
export function requireSpendApproval(stage) {
  if (process.argv.includes("--allow-api-spend") || process.env.VEGBATCH_ALLOW_API_SPEND === "1") return;
  console.error(`
${stage} calls the Anthropic API, which bills real money to the key in hub/.env.

Policy for this project is subscription-first: bulk extraction is finished, and
day-to-day work (review, lists, staples, add-recipe) costs nothing. To add a
recipe or two, do it in-session and use:  node add-recipe.mjs <file.json>

If you really do mean to spend, re-run with --allow-api-spend.
`.trim());
  process.exit(2);
}

export function ensureDirs() {
  for (const d of [WORK, PREPPED, DATA]) fs.mkdirSync(d, { recursive: true });
}

/** Read a JSON file, or return `fallback` if it doesn't exist. */
export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** `--limit 20` / `--force` / `--only PXL_x.jpg` off the command line. */
export function args() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    only: get("--only"),
    force: argv.includes("--force"),
    concurrency: get("--concurrency") ? Number(get("--concurrency")) : 5,
  };
}

/**
 * Ask Claude for JSON matching `schema`. Retries transient failures; every
 * stage in this pipeline is idempotent so a thrown error is always safe.
 */
export async function askJson({ system, content, schema, maxTokens = 16000, effort = "high" }) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
        output_config: {
          effort,
          format: { type: "json_schema", schema },
        },
      });
      if (response.stop_reason === "refusal") {
        throw new Error(`refused: ${response.stop_details?.explanation ?? "no detail"}`);
      }
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      return { data: JSON.parse(text), usage: response.usage };
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.APIConnectionError ||
        (error instanceof Anthropic.APIError && error.status >= 500);
      if (!retryable || attempt === 3) throw error;
      const delay = 2000 * 2 ** attempt;
      console.warn(`  retry ${attempt + 1}/3 in ${delay / 1000}s (${error.message})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Run `fn` over `items` with at most `size` in flight. Results keep input
 * order. A whole-run failure is worse than a slow run, so each task's error is
 * captured and returned rather than thrown.
 */
export async function mapPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** Rough running cost, Opus 5 rates. */
export function costOf(usages) {
  let input = 0;
  let output = 0;
  for (const u of usages) {
    input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    output += u.output_tokens ?? 0;
  }
  return (input / 1e6) * 5 + (output / 1e6) * 25;
}

export function imageBlock(base64) {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } };
}
