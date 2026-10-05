/**
 * Apply SQL to the VegBatch Supabase project.
 *
 * Uses the Management API's query endpoint with the account token from the
 * hub's .env, so no database password or direct connection is needed.
 *
 *   node db.mjs apply sql/001_schema.sql
 *   node db.mjs check            -- what exists, and is RLS on
 *   node db.mjs query "select count(*) from staples"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readEnv = (p) => Object.fromEntries(
  fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const env = readEnv(path.join(here, "..", ".env"));
const hub = readEnv(path.resolve(here, "..", "..", "hub", ".env"));
const TOKEN = hub.SUPABASE_ACCESS_TOKEN;
const REF = env.SUPABASE_REF;
if (!TOKEN || !REF) throw new Error("need SUPABASE_ACCESS_TOKEN (hub/.env) and SUPABASE_REF (.env)");

async function run(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "apply") {
  const file = path.isAbsolute(arg) ? arg : path.join(here, arg);
  console.log(`applying ${path.basename(file)} to ${REF}`);
  await run(fs.readFileSync(file, "utf8"));
  console.log("  ok");
} else if (cmd === "query") {
  console.log(JSON.stringify(await run(arg), null, 2));
} else if (cmd === "check" || !cmd) {
  const tables = await run(`
    select c.relname as table,
           c.relrowsecurity as rls,
           (select count(*) from pg_policies p where p.tablename = c.relname) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`);
  console.log(`\n${REF} — public schema\n`);
  for (const t of tables) {
    const flag = t.rls ? (t.policies > 0 ? "RLS" : "RLS, NO POLICIES") : "*** NO RLS ***";
    console.log(`  ${String(t.table).padEnd(18)} ${String(flag).padEnd(18)} ${t.policies} policies`);
  }
  const bad = tables.filter((t) => !t.rls || t.policies === 0);
  console.log(bad.length
    ? `\n  ⚠ ${bad.length} table(s) unprotected: ${bad.map((t) => t.table).join(", ")}`
    : `\n  every table has RLS and at least one policy`);
} else {
  console.log("usage: node db.mjs [check|apply <file>|query <sql>]");
}
