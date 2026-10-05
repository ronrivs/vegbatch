/**
 * Read what people have sent through the feedback form.
 *
 * The email is a notification; this table is the record. If Resend ever has
 * a bad day the submissions are still here, and without a way to read them
 * that record is only theoretical. Anonymous visitors can write to this
 * table and cannot read it, so this needs the service role.
 *
 *   node feedback.mjs            # the last 20
 *   node feedback.mjs --all
 *   node feedback.mjs --failed   # only ones whose email notification failed
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT } from "./lib/config.mjs";

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(PROJECT, ".env"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

const all = process.argv.includes("--all");
const failedOnly = process.argv.includes("--failed");
const q = new URLSearchParams({ select: "*", order: "created_at.desc" });
if (!all) q.set("limit", "20");
if (failedOnly) q.set("notify_error", "not.is.null");

const rows = await (await fetch(`${env.SUPABASE_URL}/rest/v1/feedback?${q}`, { headers: auth })).json();
if (!Array.isArray(rows)) { console.error(rows); process.exit(1); }

if (!rows.length) { console.log(`\nno feedback${failedOnly ? " with a failed notification" : ""} yet\n`); process.exit(0); }

console.log(`\n${rows.length} submission${rows.length > 1 ? "s" : ""}\n`);
for (const r of rows) {
  const when = new Date(r.created_at).toLocaleString();
  console.log(`  ${when}  [${r.kind}]  ${r.name} <${r.email}>`);
  if (r.page) console.log(`    from ${r.page}`);
  if (r.notify_error) console.log(`    ⚠ email did not send: ${r.notify_error}`);
  for (const line of r.message.split("\n")) console.log(`    ${line}`);
  console.log();
}
