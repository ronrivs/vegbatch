/**
 * Proves "delete my data" actually deletes the account.
 *
 * Creates a throwaway user, gives it a household with data, signs in AS that
 * user, calls the RPC with nothing but their own JWT, and then checks with
 * the service role that every trace is gone. Asserting the function exists
 * would prove nothing — the question is whether a signed-in person can erase
 * themselves and nobody else.
 *
 * Touches only the throwaway account. Never run against a real one.
 *
 *   node test-delete-account.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT } from "./lib/config.mjs";

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(PROJECT, ".env"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const URL_ = env.SUPABASE_URL, ANON = env.SUPABASE_ANON_KEY, SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const j = async (r) => { try { return await r.json(); } catch { return null; } };

console.log("\naccount deletion\n");

const email = `delete-test-${Date.now()}@vegbatch.invalid`;
const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// --- 1. a real user, with real household data hanging off it
const made = await j(await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST", headers: admin,
  body: JSON.stringify({ email, password, email_confirm: true }),
}));
const uid = made?.id;
t("throwaway user created", !!uid, JSON.stringify(made)?.slice(0, 120));
if (!uid) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

await new Promise((r) => setTimeout(r, 1200)); // the signup trigger
const prof = (await j(await fetch(`${URL_}/rest/v1/profiles?id=eq.${uid}&select=*`, { headers: admin })))?.[0];
const hh = prof?.household_id;
t("the signup trigger gave it a household", !!hh, JSON.stringify(prof)?.slice(0, 120));

await fetch(`${URL_}/rest/v1/staples`, {
  method: "POST", headers: admin,
  body: JSON.stringify({ household_id: hh, item: "delete-test marker", qty: 1 }),
});
const before = await j(await fetch(`${URL_}/rest/v1/staples?household_id=eq.${hh}&select=item`, { headers: admin }));
t("and household data to lose", before?.length === 1);

// --- 2. anon must not be able to reach it at all
const anonTry = await fetch(`${URL_}/rest/v1/rpc/delete_own_account`, {
  method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: "{}",
});
t("a signed-out caller is refused", anonTry.status === 401 || anonTry.status === 403 || anonTry.status === 404,
  `got ${anonTry.status}`);
t("and the user still exists after that attempt",
  (await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { headers: admin })).status === 200);

// --- 3. the user deletes themselves, with nothing but their own session
const signedIn = await j(await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
}));
const jwt = signedIn?.access_token;
t("the user can sign in", !!jwt, JSON.stringify(signedIn)?.slice(0, 120));

const del = await fetch(`${URL_}/rest/v1/rpc/delete_own_account`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  body: "{}",
});
t("the RPC accepts their own session", del.ok, `${del.status} ${(await del.text()).slice(0, 140)}`);

// --- 4. nothing may survive
await new Promise((r) => setTimeout(r, 600));
t("the auth user is gone",
  (await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { headers: admin })).status === 404);
t("the profile is gone",
  (await j(await fetch(`${URL_}/rest/v1/profiles?id=eq.${uid}&select=id`, { headers: admin })))?.length === 0);
t("the household is gone, not orphaned",
  (await j(await fetch(`${URL_}/rest/v1/households?id=eq.${hh}&select=id`, { headers: admin })))?.length === 0);
t("its staples went with it",
  (await j(await fetch(`${URL_}/rest/v1/staples?household_id=eq.${hh}&select=item`, { headers: admin })))?.length === 0);

// --- 5. and the session it was holding is now worthless
const after = await fetch(`${URL_}/rest/v1/profiles?select=id`, {
  headers: { apikey: ANON, Authorization: `Bearer ${jwt}` },
});
t("the old token can no longer read anything",
  (await j(after.clone()))?.length === 0 || after.status >= 400, `${after.status}`);

// --- 6. leave nothing behind even if something above failed
const stray = await j(await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers: admin }));
const leftovers = (stray?.users ?? []).filter((u) => (u.email ?? "").startsWith("delete-test-"));
for (const u of leftovers) {
  await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
}
t("no test accounts left behind", leftovers.length === 0, `cleaned ${leftovers.length}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
