/**
 * Outbound shopping links.
 *
 * Deliberately **search** links, not product links. Matching 442 canonical
 * ingredients to retailer SKUs is permanent maintenance — items go out of
 * stock, get relisted, change pack size — and the whole point of this first
 * version is to find out whether anyone clicks before paying that cost.
 * A search URL needs no catalogue and never goes stale.
 *
 * The affiliate tags below are empty. Links work without them; they simply
 * earn nothing. Fill them in when the programmes are approved and every link
 * starts carrying credit with no other change.
 *
 * Do not join Amazon Associates until there is traffic to convert — they
 * close accounts with no qualifying sale within 180 days of signup.
 */

export const AFFILIATE = {
  amazon: "",   // Associates tag, e.g. "vegbatch-20"
  target: "",   // Impact publisher id
  walmart: "",  // Impact publisher id
};

export const RETAILERS = [
  {
    id: "amazon",
    name: "Amazon",
    url: (q) => {
      const u = new URL("https://www.amazon.com/s");
      u.searchParams.set("k", q);
      u.searchParams.set("i", "grocery");
      if (AFFILIATE.amazon) u.searchParams.set("tag", AFFILIATE.amazon);
      return u.toString();
    },
  },
  {
    id: "target",
    name: "Target",
    url: (q) => {
      const u = new URL("https://www.target.com/s");
      u.searchParams.set("searchTerm", q);
      if (AFFILIATE.target) u.searchParams.set("afid", AFFILIATE.target);
      return u.toString();
    },
  },
  {
    id: "walmart",
    name: "Walmart",
    url: (q) => {
      const u = new URL("https://www.walmart.com/search");
      u.searchParams.set("q", q);
      if (AFFILIATE.walmart) u.searchParams.set("affiliateId", AFFILIATE.walmart);
      return u.toString();
    },
  },
];

/**
 * What to actually search for.
 *
 * The ingredient name alone is usually right, but a few need help: "fresh
 * basil" beats "basil" in a grocery search, and a form is worth keeping
 * because dried and fresh are different products.
 */
export function searchTerm(entry) {
  const name = entry.ingredient?.name ?? entry.label ?? "";
  const form = entry.form && entry.form !== "fresh" ? `${entry.form} ` : "";
  return `${form}${name}`.trim();
}

export const DISCLOSURE =
  "Some links are affiliate links. If you buy through them we may earn a " +
  "small commission at no cost to you. It helps keep VegBatch free.";
