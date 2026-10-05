/**
 * Exercises the photo path as a real signed-in user.
 *
 * This is the one account feature that had never been run end to end, and
 * Ron hit it: a photo uploaded to a recipe did not come back. Everything here
 * uses the ANON key plus a user JWT — the same credentials the browser has —
 * because the service role sails past the storage policies that are the
 * likely culprit, so testing with it would prove nothing.
 *
 * Creates and destroys its own account. Never touches a real one.
 *
 *   node test-photos.mjs
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

console.log("\nphoto upload and display, as a signed-in user\n");

const email = `photo-test-${Date.now()}@vegbatch.invalid`;
const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
let uid = null;

try {
  const made = await j(await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }),
  }));
  uid = made?.id;
  t("test user created", !!uid, JSON.stringify(made)?.slice(0, 120));
  if (!uid) throw new Error("no user");

  await new Promise((r) => setTimeout(r, 1200));
  const jwt = (await j(await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })))?.access_token;
  t("signed in", !!jwt);

  const asUser = { apikey: ANON, Authorization: `Bearer ${jwt}` };
  const hh = (await j(await fetch(`${URL_}/rest/v1/profiles?select=household_id`, { headers: asUser })))?.[0]?.household_id;
  t("the user can read their own household id", !!hh);

  // --- upload, exactly as lib/account.mjs does: <household>/<recipe>/<uuid>.jpg
  const storagePath = `${hh}/049/${crypto.randomUUID()}.jpg`;
  // smallest valid JPEG
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
  const up = await fetch(`${URL_}/storage/v1/object/photos/${storagePath}`, {
    method: "POST", headers: { ...asUser, "Content-Type": "image/jpeg" }, body: jpeg,
  });
  t("the user can upload into their own household folder", up.ok, `${up.status} ${(await up.text()).slice(0, 120)}`);

  const row = await fetch(`${URL_}/rest/v1/recipe_photos`, {
    method: "POST", headers: { ...asUser, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ household_id: hh, user_id: uid, recipe_id: "049", storage_path: storagePath, is_public: false }),
  });
  t("and record the row", row.ok, `${row.status} ${(await row.clone().text()).slice(0, 120)}`);

  // --- read it back, which is the half that was failing
  const rows = await j(await fetch(`${URL_}/rest/v1/recipe_photos?recipe_id=eq.049&select=*`, { headers: asUser }));
  t("the row is readable by its owner", (rows ?? []).some((p) => p.storage_path === storagePath),
    `${(rows ?? []).length} rows visible`);

  const signRes = await fetch(`${URL_}/storage/v1/object/sign/photos`, {
    method: "POST", headers: { ...asUser, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600, paths: [storagePath] }),
  });
  const signed = await j(signRes.clone());
  t("storage will sign the user's own object", signRes.ok,
    `${signRes.status} ${JSON.stringify(signed)?.slice(0, 200)}`);

  const entry = (Array.isArray(signed) ? signed : [])[0];
  t("the signed entry has no error", entry && !entry.error, JSON.stringify(entry)?.slice(0, 200));
  t("and carries a URL", !!(entry?.signedURL || entry?.signedUrl), JSON.stringify(entry)?.slice(0, 200));

  if (entry?.signedURL || entry?.signedUrl) {
    const rel = entry.signedURL ?? entry.signedUrl;
    const full = `${URL_}/storage/v1${rel.startsWith("/") ? rel : `/${rel}`}`;
    const img = await fetch(full);
    t("the signed URL actually returns the image", img.ok && (img.headers.get("content-type") ?? "").startsWith("image/"),
      `${img.status} ${img.headers.get("content-type")}`);
  }
} finally {
  // always clean up, even if an assertion above threw
  const all = await j(await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers: admin }));
  for (const u of (all?.users ?? []).filter((x) => (x.email ?? "").startsWith("photo-test-"))) {
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  const left = await j(await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers: admin }));
  t("test account cleaned up",
    !(left?.users ?? []).some((x) => (x.email ?? "").startsWith("photo-test-")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
