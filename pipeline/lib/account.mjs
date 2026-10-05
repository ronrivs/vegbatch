/**
 * Accounts: sign-in, sync, cook history, photos, click logging.
 *
 * Two rules shape all of this.
 *
 * 1. **Signed out has to keep working.** Every recipe, the planner and the
 *    grocery list work with no account, and that stays true — it is the
 *    point of a public good, and it is what `llms.txt` promises. Nothing
 *    here gates anything; it only adds sync and history.
 *
 * 2. **localStorage stays the source of truth while signed out**, and on
 *    first sign-in whatever is local is pushed up rather than discarded.
 *    Someone who has spent a month building a staples list must not lose it
 *    by signing in.
 */
import { createClient } from "/lib/supabase.mjs";

export const CONFIG = {
  url: "__SUPABASE_URL__",
  anonKey: "__SUPABASE_ANON_KEY__",
};

export const supabase = CONFIG.url.startsWith("http")
  ? createClient(CONFIG.url, CONFIG.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

/** Auth is optional infrastructure — if it can't load, the app still runs. */
export const enabled = () => supabase !== null;

let session = null;
let profile = null;
const listeners = new Set();

export const user = () => session?.user ?? null;
export const household = () => profile?.household_id ?? null;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const announce = () => listeners.forEach((fn) => fn(user()));

export async function init() {
  if (!enabled()) return null;
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (session) await loadProfile();
  supabase.auth.onAuthStateChange(async (_event, s) => {
    const was = session?.user?.id;
    session = s;
    profile = null;
    if (session) await loadProfile();
    if (was !== session?.user?.id) announce();
  });
  return user();
}

async function loadProfile() {
  // The signup trigger creates this row, but a first sign-in can race it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (data) { profile = data; return; }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function signIn() {
  if (!enabled()) return;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${location.origin}/account` },
  });
}

export async function signOut() {
  if (!enabled()) return;
  await supabase.auth.signOut();
  session = null;
  profile = null;
  announce();
}

// ------------------------------------------------------------- staples

export async function pullStaples() {
  if (!user()) return null;
  const { data } = await supabase.from("staples").select("*").order("item");
  return data?.map((s) => ({
    item: s.item, qty: Number(s.qty), unit: s.unit, aisle: s.aisle,
    note: s.note, canonical: s.canonical, active: s.active,
  })) ?? null;
}

export async function pushStaples(items) {
  if (!user()) return;
  const hh = household();
  if (!hh) return;
  // Replace wholesale: the list is small and this keeps deletions correct
  // without tracking per-row identity in the client.
  await supabase.from("staples").delete().eq("household_id", hh);
  if (!items.length) return;
  await supabase.from("staples").insert(items.map((s) => ({
    household_id: hh, item: s.item, qty: s.qty, unit: s.unit,
    aisle: s.aisle, note: s.note, canonical: s.canonical, active: s.active !== false,
  })));
}

// ---------------------------------------------------------------- plan

export async function pullPlan() {
  if (!user()) return null;
  const { data } = await supabase.from("plans").select("*").maybeSingle();
  return data ? { recipes: data.recipes, ticked: data.ticked, options: data.options,
                  days: data.days, people: data.people } : null;
}

export async function pushPlan({ recipes, ticked, options, days, people }) {
  if (!user()) return;
  const hh = household();
  if (!hh) return;
  await supabase.from("plans").upsert({
    household_id: hh, recipes, ticked, options,
    days: days ?? 5, people: people ?? 2,
  }, { onConflict: "household_id" });
}

// ------------------------------------------------------------- feedback

/**
 * Send a suggestion or bug report. Works signed out — the person most likely
 * to hit a bug is the one who never made an account.
 *
 * Deliberately does NOT ask for the row back. Anonymous callers may insert
 * and may not select, so requesting a representation turns a perfectly good
 * submission into a 401. supabase-js only asks for one if you chain
 * `.select()`, so don't.
 *
 * The database re-checks name, email shape, kind and message length — the
 * form is not what guards the endpoint, since anyone can POST to PostgREST
 * directly.
 */
export async function sendFeedback({ name, email, kind, message, page }) {
  if (!enabled()) return { error: "Feedback isn't available right now." };
  const { error } = await supabase.from("feedback").insert({
    name: String(name ?? "").trim(),
    email: String(email ?? "").trim(),
    kind,
    message: String(message ?? "").trim(),
    page: page ?? null,
    user_id: user()?.id ?? null,
  });
  return error ? { error: error.message } : { ok: true };
}

// ------------------------------------------------------ shopping history

/**
 * Past shops, newest first.
 *
 * The items are stored frozen rather than re-derived from the plan: a record
 * of what was bought has to stay true after a recipe is edited or a pack size
 * corrected, and re-deriving would quietly rewrite history.
 */
export async function pullLists() {
  if (!user()) return [];
  const { data } = await supabase.from("saved_lists").select("*").order("saved_at", { ascending: false });
  return data?.map(rowToList) ?? [];
}

const rowToList = (r) => ({
  id: r.id, saved_at: r.saved_at, title: r.title,
  recipes: r.recipes ?? [], options: r.options ?? {}, items: r.items ?? [],
  n_items: r.n_items, n_ticked: r.n_ticked,
});

export async function pushList(list) {
  if (!user()) return null;
  const hh = household();
  if (!hh) return null;
  const { data } = await supabase.from("saved_lists").insert({
    household_id: hh,
    saved_at: list.saved_at,
    title: list.title,
    recipes: list.recipes,
    options: list.options,
    items: list.items,
    n_items: list.n_items,
    n_ticked: list.n_ticked,
    created_by: user().id,
  }).select().maybeSingle();
  return data ? rowToList(data) : null;
}

export async function deleteList(id) {
  if (!user()) return;
  await supabase.from("saved_lists").delete().eq("id", id);
}

// -------------------------------------------------------- cook history

/** Recipe id -> ISO date last cooked. Drives the card label. */
export async function pullCookHistory() {
  if (!user()) return new Map();
  const { data } = await supabase
    .from("cook_history").select("recipe_id, cooked_on").order("cooked_on", { ascending: false });
  const last = new Map();
  for (const row of data ?? []) if (!last.has(row.recipe_id)) last.set(row.recipe_id, row.cooked_on);
  return last;
}

export async function markCooked(recipeId, on = new Date().toISOString().slice(0, 10)) {
  if (!user()) return false;
  const hh = household();
  if (!hh) return false;
  const { error } = await supabase.from("cook_history")
    .insert({ household_id: hh, recipe_id: recipeId, cooked_on: on });
  return !error;
}

export async function unmarkCooked(recipeId, on) {
  if (!user()) return;
  await supabase.from("cook_history").delete().eq("recipe_id", recipeId).eq("cooked_on", on);
}

/** "3 weeks ago" reads better than a date when the question is "recently?". */
export function sinceLabel(iso) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(`${iso}T12:00:00`)) / 86400000);
  if (days <= 0) return "cooked today";
  if (days === 1) return "cooked yesterday";
  if (days < 14) return `cooked ${days} days ago`;
  if (days < 60) return `cooked ${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `cooked ${Math.round(days / 30)} months ago`;
  return "cooked over a year ago";
}

// -------------------------------------------------------------- photos

/**
 * The bucket is private, so every read goes through a short-lived signed URL.
 * That is what makes "private unless you share it" actually true — a public
 * bucket would expose every photo to anyone holding the path, and the
 * is_public flag would be decoration.
 */
export async function listPhotos(recipeId) {
  if (!enabled()) return [];
  const { data } = await supabase.from("recipe_photos")
    .select("*").eq("recipe_id", recipeId).order("created_at", { ascending: false });
  if (!data?.length) return [];

  const signed = await supabase.storage.from("photos")
    .createSignedUrls(data.map((p) => p.storage_path), 3600);
  const urlFor = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));

  // A row whose URL didn't come back used to be dropped here, so a storage
  // failure was indistinguishable from having no photos at all — the section
  // just said "Photos" and the person's upload appeared to have vanished.
  // Hand the unsigned ones back too and let the caller say so.
  return data.map((p) => ({
    ...p,
    url: urlFor.get(p.storage_path) ?? null,
    mine: p.user_id === user()?.id,
  }));
}

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Shrink a camera photo before it leaves the phone.
 *
 * A modern phone shoots 3-12 MB; the first real upload was 2.9 MB for an
 * image displayed at most a few hundred pixels wide. That is paid for three
 * times — the uploader's data, the bucket, and every later viewer's download
 * — for no visible gain. 1600px is the same bound the extraction pipeline
 * uses on the source photos and is still sharp on a retina screen.
 *
 * `imageOrientation: "from-image"` is the part that is easy to miss: phone
 * photos carry EXIF rotation, and drawing to a canvas discards it, so
 * without this a portrait photo silently uploads on its side.
 *
 * Every failure path returns the original file. A photo that uploads too
 * large beats a photo that doesn't upload.
 */
async function shrink(file) {
  if (!file?.type?.startsWith("image/")) return { blob: file, ext: null };
  if (file.type === "image/gif") return { blob: file, ext: null }; // would lose the animation
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    // already modest in both dimensions and bytes — re-encoding would only
    // throw away quality
    if (scale === 1 && file.size <= 600_000) { bmp.close?.(); return { blob: file, ext: null }; }

    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY })
      : await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
    // a small PNG screenshot can come out bigger as JPEG; keep the smaller one
    if (!blob || blob.size >= file.size) return { blob: file, ext: null };
    return { blob, ext: "jpg" };
  } catch {
    return { blob: file, ext: null };
  }
}

export async function uploadPhoto(recipeId, file, { isPublic = false, caption = null } = {}) {
  if (!user()) return { error: "not signed in" };
  const hh = household();
  const { blob, ext: reEncoded } = await shrink(file);
  const fromName = (file.name.split(".").pop() || "").toLowerCase();
  const ext = reEncoded ?? (/^[a-z0-9]{1,5}$/.test(fromName) ? fromName : "jpg");
  const key = `${hh}/${recipeId}/${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from("photos")
    .upload(key, blob, { contentType: blob.type || file.type });
  if (up.error) return { error: up.error.message };
  const { error } = await supabase.from("recipe_photos").insert({
    household_id: hh, user_id: user().id, recipe_id: recipeId,
    storage_path: key, caption, is_public: isPublic,
  });
  return error ? { error: error.message } : { ok: true };
}

/**
 * One photo per recipe, for the browse grid: recipe id -> signed URL.
 *
 * The cards have always shown a generated tile, so a photo you took only
 * existed on the recipe page — which reads as the upload not having worked.
 * Newest wins where a recipe has several.
 */
export async function photoThumbs() {
  if (!user()) return new Map();
  const { data } = await supabase.from("recipe_photos")
    .select("recipe_id, storage_path").order("created_at", { ascending: false });
  if (!data?.length) return new Map();

  const newest = new Map();
  for (const p of data) if (!newest.has(p.recipe_id)) newest.set(p.recipe_id, p.storage_path);

  const signed = await supabase.storage.from("photos")
    .createSignedUrls([...newest.values()], 3600);
  const urlFor = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));

  const out = new Map();
  for (const [id, p] of newest) {
    const url = urlFor.get(p);
    if (url) out.set(id, url);
  }
  return out;
}

export async function deletePhoto(photo) {
  if (!user()) return;
  await supabase.storage.from("photos").remove([photo.storage_path]);
  await supabase.from("recipe_photos").delete().eq("id", photo.id);
}

// -------------------------------------------------------------- delete

/**
 * Remove everything this household owns.
 *
 * The auth user itself can only be deleted with the service role, which has
 * no business in a browser — so this clears every row and file the person
 * put here, and signs them out. Their email remains in auth.users until we
 * add a server-side endpoint; the account page says so rather than implying
 * a completeness we can't deliver from the client.
 */
/** Returns true only if the account is really gone. The caller must not sign
 *  out or clear anything on false — a half-delete that looks successful is
 *  worse than a failure that says so. */
export async function deleteEverything() {
  if (!user()) return false;
  const hh = household();
  // No household should be impossible, but a missing profile must not stop
  // someone deleting their account — fall through to the RPC regardless.
  if (!hh) return !(await supabase.rpc("delete_own_account")).error;

  // Files first. Object storage is unreachable from SQL, and working out
  // which files exist needs the very session we are about to destroy.
  const { data: photos } = await supabase.from("recipe_photos").select("storage_path");
  if (photos?.length) {
    await supabase.storage.from("photos").remove(photos.map((p) => p.storage_path));
  }
  for (const table of ["recipe_photos", "cook_history", "staples", "plans", "saved_lists"]) {
    await supabase.from(table).delete().eq("household_id", hh);
  }

  // Then the account itself. Until this existed the button cleared the data
  // and left the person a registered user, which is not what "delete my
  // account" means. The RPC also drops the household once its last member
  // goes, so nothing is left orphaned behind RLS where it can never be
  // reached again. See sql/004_delete_account.sql.
  const { error } = await supabase.rpc("delete_own_account");
  if (error) return false;

  // Only now is the local copy safe to discard: if the server-side delete had
  // failed, wiping it too would destroy the one copy they still had while
  // leaving the account standing.
  for (const k of ["vb-plan", "vb-ticked", "vb-staples", "vb-week", "vb-opts", "vb-history"]) {
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  }
  return true;
}

export async function setMarketingOptIn(on) {
  if (!user()) return;
  await supabase.from("profiles").update({ marketing_opt_in: !!on }).eq("id", user().id);
  if (profile) profile.marketing_opt_in = !!on;
}

export const marketingOptIn = () => !!profile?.marketing_opt_in;

// -------------------------------------------------------------- clicks

/**
 * Log an outbound retailer click. Anonymous by design — no user, no
 * household, just retailer and search term. This exists to answer one
 * question ("does anyone click?") and should not become analytics.
 * Fire-and-forget: a failure here must never interrupt the click.
 */
export function logClick(retailer, term) {
  if (!enabled()) return;
  try {
    supabase.from("outbound_clicks").insert({ retailer, term }).then(() => {}, () => {});
  } catch { /* never block the navigation */ }
}
