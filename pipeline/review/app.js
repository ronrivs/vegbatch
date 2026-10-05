/**
 * Review UI.
 *
 * One rule drives the layout: the reviewer's eyes should never have to hunt
 * for what the extraction was unsure about. Estimated quantities, applied
 * household edits and meat findings are colour-coded in place, next to the
 * field you'd fix, not collected in a report somewhere else.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

const MEAT = new Set(["meat", "fish", "meat_broth", "gelatin"]);

let recipes = [];
let current = null;
let page = 0;
const rotations = JSON.parse(localStorage.getItem("vb-rot") ?? "{}");

// ---------- derived state ----------

const estimatedIn = (r) =>
  r.components.flatMap((c) => c.ingredients).filter((i) => i.qty_estimated).length;

const blockersIn = (r) => (r.animal_products ?? []).filter((a) => MEAT.has(a.type));

function severity(r) {
  if (r.excluded) return "alert";
  if (r.reviewed) return "ok";
  if (blockersIn(r).length) return "alert";
  return r.needs_review ? "review" : "ok";
}

const FILTERS = {
  all: () => true,
  review: (r) => r.needs_review && !r.reviewed,
  estimated: (r) => estimatedIn(r) > 0,
  edits: (r) => (r.household_edits ?? []).length > 0,
  substituted: (r) => (r.household_edits ?? []).some((e) => e.kind === "meat_substitution"),
  excluded: (r) => r.excluded === true,
  notveg: (r) => blockersIn(r).length > 0,
  drafted: (r) => r.method_source === "drafted",
  done: (r) => r.reviewed,
};

const visible = () => recipes.filter(FILTERS[$("#filter").value]);

// ---------- persistence ----------

let saveTimer;
function save({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const run = async () => {
    const res = await fetch("/api/recipe", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(current),
    });
    if (res.ok) {
      const flash = $("#saved");
      if (flash) {
        flash.classList.add("on");
        setTimeout(() => flash.classList.remove("on"), 900);
      }
    }
    renderProgress();
    renderList();
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 500);
}

/** Bind an input to a path on the current recipe. */
function bind(node, get, set, { number = false } = {}) {
  node.value = get() ?? "";
  node.addEventListener("input", () => {
    const raw = node.value;
    set(number ? (raw === "" ? null : Number(raw)) : raw);
    save();
  });
  return node;
}

// ---------- rendering ----------

function renderProgress() {
  const done = recipes.filter((r) => r.reviewed).length;
  $("#progress").textContent = `${done} / ${recipes.length} approved`;
  $("#barfill").style.width = recipes.length ? `${(done / recipes.length) * 100}%` : "0";
}

function renderList() {
  const rows = $("#rows");
  rows.textContent = "";
  const list = visible();
  if (!list.length) {
    rows.append(el("div", { className: "empty", textContent: "Nothing in this filter." }));
    return;
  }
  for (const r of list) {
    const row = el("div", { className: `row ${r.reviewed ? "done" : ""} ${current?.id === r.id ? "active" : ""}` }, [
      el("span", { className: `dot ${severity(r)}` }),
      el("span", { className: "id", textContent: r.id }),
      el("span", { className: "t", textContent: r.title }),
    ]);
    row.onclick = () => open(r);
    rows.append(row);
  }
}

function renderPhoto() {
  const tabs = $("#pagetabs");
  tabs.textContent = "";
  if (!current) return;
  current.pages.forEach((p, i) => {
    const b = el("button", { textContent: `Page ${i + 1}` });
    if (i === page) b.classList.add("primary");
    b.onclick = () => { page = i; renderPhoto(); };
    tabs.append(b);
  });
  const file = current.pages[page];
  const img = $("#img");
  img.src = `/photo/${encodeURIComponent(file)}`;
  img.style.transform = `rotate(${rotations[file] ?? 0}deg)`;
}

function rotate() {
  if (!current) return;
  const file = current.pages[page];
  rotations[file] = ((rotations[file] ?? 0) + 90) % 360;
  localStorage.setItem("vb-rot", JSON.stringify(rotations));
  renderPhoto();
}

function banners() {
  const out = [];

  if (current.excluded) {
    const restore = el("button", { textContent: "Put it back in", style: "margin-top:6px" });
    restore.onclick = () => {
      current.excluded = false;
      current.exclusion_reason = null;
      save({ immediate: true });
      renderForm();
    };
    out.push(el("div", { className: "banner alert" }, [
      el("b", { textContent: "Excluded — no honest vegetarian version" }),
      el("div", { textContent: current.exclusion_reason ?? "" }),
      el("div", { style: "margin-top:4px", textContent: "It stays in the data and keeps its photos, but is left out of the planner." }),
      restore,
    ]));
  }

  const blockers = blockersIn(current);
  if (blockers.length) {
    out.push(
      el("div", { className: "banner alert" }, [
        el("b", { textContent: "Contains meat or fish — decide what to do" }),
        el("ul", {}, blockers.map((b) => el("li", { textContent: `${b.ingredient} (${b.type}) — ${b.note}` }))),
        el("div", { style: "margin-top:6px", textContent: "Nothing was removed. Edit the ingredient to substitute it, or leave the recipe out of the public set." }),
      ]),
    );
  }
  const ambiguous = (current.animal_products ?? []).filter((a) => a.type === "ambiguous");
  if (ambiguous.length) {
    out.push(
      el("div", { className: "banner warn" }, [
        el("b", { textContent: "Ambiguous ingredient — check the label" }),
        el("ul", {}, ambiguous.map((a) => el("li", { textContent: `${a.ingredient} — ${a.note}` }))),
      ]),
    );
  }
  const EDIT_LABEL = {
    broth_substitution: "Broth substituted",
    meat_substitution: "Meat substituted",
    annotation: "Handwritten note applied",
    correction: "Correction applied",
  };
  for (const e of current.household_edits ?? []) {
    out.push(
      el("div", { className: "banner info" }, [
        el("b", { textContent: EDIT_LABEL[e.kind] ?? "Edit applied" }),
        el("div", { textContent: `On the page: “${e.written}”` }),
        el("div", { textContent: `Applied: ${e.applied}` }),
      ]),
    );
  }
  if (current.method_source === "drafted") {
    out.push(el("div", { className: "banner warn" }, [
      el("b", { textContent: "Method was drafted, not transcribed" }),
      el("div", { textContent: "The card had no instructions. These steps were written from the ingredients — check they match how you actually make it." }),
    ]));
  }
  if (current.review_notes) {
    out.push(el("div", { className: "banner warn" }, [
      el("b", { textContent: "Extraction notes" }),
      el("div", { textContent: current.review_notes }),
    ]));
  }
  return out;
}

function ingredientCard(ing, list, idx) {
  const cls = ing.qty_estimated ? "ing est" : ing.substituted_from ? "ing sub" : "ing";
  const card = el("div", { className: cls });

  const qty = el("div", { className: "qty" });
  qty.append(
    bind(el("input", { placeholder: "qty", type: "number", step: "any" }), () => ing.qty_min, (v) => { ing.qty_min = v; if (v !== null) ing.qty_estimated = false; }, { number: true }),
    bind(el("input", { placeholder: "max", type: "number", step: "any" }), () => ing.qty_max, (v) => (ing.qty_max = v), { number: true }),
    bind(el("input", { placeholder: "unit" }), () => ing.unit, (v) => (ing.unit = v || null)),
    bind(el("input", { placeholder: "ingredient" }), () => ing.item, (v) => (ing.item = v)),
  );
  card.append(qty);

  card.append(el("div", { className: "prep" }, [
    bind(el("input", { placeholder: "prep note — finely chopped, rinsed and drained" }), () => ing.prep_note, (v) => (ing.prep_note = v || null)),
  ]));

  const meta = el("div", { className: "meta" });
  if (ing.qty_estimated) meta.append(el("span", { className: "chip est", textContent: "estimated" }));
  if (ing.substituted_from) meta.append(el("span", { className: "chip sub", textContent: `was: ${ing.substituted_from}` }));
  for (const [key, label] of [["optional", "optional"], ["to_taste", "to taste"]]) {
    const box = el("input", { type: "checkbox", checked: ing[key] });
    box.onchange = () => { ing[key] = box.checked; save(); };
    meta.append(el("label", { className: "chk" }, [box, label]));
  }
  const del = el("button", { textContent: "Remove", style: "margin-left:auto" });
  del.onclick = () => { list.splice(idx, 1); renderForm(); save(); };
  meta.append(del);
  card.append(meta);

  if (ing.qty_estimated && ing.estimate_basis) {
    card.append(el("div", { className: "why", textContent: `Estimated — ${ing.estimate_basis}` }));
  }
  card.append(el("div", { className: "raw", textContent: `on the page:  ${ing.raw_text}` }));
  return card;
}

function renderForm() {
  const form = $("#form");
  form.textContent = "";
  if (!current) return form.append(el("div", { className: "empty", textContent: "Select a recipe." }));

  form.append(...banners());

  const field = (label, node) => el("div", { className: "field" }, [el("label", { textContent: label }), node]);

  form.append(field("Title", bind(el("input"), () => current.title, (v) => (current.title = v))));
  form.append(field("Description (ours, not the source's)", bind(el("textarea"), () => current.description, (v) => (current.description = v))));

  const meta = el("div", { className: "grid4" });
  meta.append(
    field("Prep (min)", bind(el("input", { type: "number" }), () => current.prep_min, (v) => (current.prep_min = v), { number: true })),
    field("Cook (min)", bind(el("input", { type: "number" }), () => current.cook_min, (v) => (current.cook_min = v), { number: true })),
    field("Total (min)", bind(el("input", { type: "number" }), () => current.total_min, (v) => (current.total_min = v), { number: true })),
    field("Course", bind(el("input"), () => current.course, (v) => (current.course = v || null))),
  );
  form.append(meta);
  const meta2 = el("div", { className: "grid2" });
  meta2.append(
    field("Yield", bind(el("input"), () => current.yield_text, (v) => (current.yield_text = v || null))),
    field("Cuisine", bind(el("input"), () => current.cuisine, (v) => (current.cuisine = v || null))),
  );
  form.append(meta2);

  for (const comp of current.components) {
    const head = el("h2", { textContent: comp.name });
    form.append(head);
    comp.ingredients.forEach((ing, i) => form.append(ingredientCard(ing, comp.ingredients, i)));
    const add = el("button", { textContent: "+ Add ingredient" });
    add.onclick = () => {
      comp.ingredients.push({
        raw_text: "(added in review)", item: "", qty_min: null, qty_max: null, unit: null,
        prep_note: null, optional: false, to_taste: false,
        qty_estimated: false, estimate_basis: null, substituted_from: null,
      });
      renderForm(); save();
    };
    form.append(add);
  }

  form.append(el("h2", { textContent: `Method (${current.method_source})` }));
  current.instructions.forEach((s, i) => {
    const ta = bind(el("textarea"), () => s.text, (v) => (s.text = v));
    form.append(el("div", { className: "step" }, [el("span", { className: "n", textContent: `${i + 1}.` }), ta]));
  });

  form.append(el("h2", { textContent: "Reviewer notes" }));
  form.append(bind(el("textarea", { placeholder: "Anything you changed or want to remember" }),
    () => current.reviewer_notes, (v) => (current.reviewer_notes = v)));

  const approve = el("button", { className: "primary", textContent: current.reviewed ? "✓ Approved — unapprove" : "Approve & next  (Ctrl+↵)" });
  approve.onclick = () => (current.reviewed ? unapprove() : approveNext());
  const actions = el("div", { className: "actions" }, [
    approve,
    el("span", { id: "saved", className: "saved", textContent: "saved" }),
    el("span", { className: "spacer", style: "flex:1" }),
    el("span", { className: "hint", textContent: `${current.id} · ${current.pages.length} page${current.pages.length > 1 ? "s" : ""}` }),
  ]);
  form.append(actions);
}

// ---------- navigation ----------

function open(r) {
  current = r;
  page = 0;
  renderList();
  renderPhoto();
  renderForm();
  $("#form").scrollTop = 0;
}

function step(delta) {
  const list = visible();
  const i = list.findIndex((r) => r.id === current?.id);
  const next = list[(i === -1 ? 0 : i + delta + list.length) % list.length];
  if (next) open(next);
}

async function approveNext() {
  current.reviewed = true;
  current.needs_review = false;
  const list = visible();
  const i = list.findIndex((r) => r.id === current.id);
  await save({ immediate: true });
  const after = visible();
  open(after[Math.min(i, after.length - 1)] ?? recipes[0]);
}

function unapprove() {
  current.reviewed = false;
  save({ immediate: true });
  renderForm();
}

// ---------- wiring ----------

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return approveNext(); }
  if (typing) return;
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
  if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  if (e.key === "r") rotate();
});

$("#rotate").onclick = rotate;
$("#img").onclick = (e) => e.target.classList.toggle("zoom");
$("#filter").onchange = () => { renderList(); const v = visible(); if (v.length && !v.some((r) => r.id === current?.id)) open(v[0]); };

recipes = await (await fetch("/api/recipes")).json();
renderProgress();
renderList();
const start = visible()[0] ?? recipes[0];
if (start) open(start);
