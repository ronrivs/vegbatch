/**
 * Minimal browser stand-ins for the two Node globals the bundled Supabase
 * client references.
 *
 * The upstream bundle imports `process` and `Buffer` from esm.sh. Leaving
 * those imports in place would mean the app cannot load at all without a
 * network round-trip to a third party — fatal for a PWA whose whole purpose
 * is working in a shop with no signal, and a third-party dependency on the
 * critical path besides.
 *
 * Neither is genuinely used by the client in a browser: `process.env` is read
 * for optional configuration, and `Buffer` only appears on Node code paths.
 * These stubs satisfy the references without pretending to implement Node.
 */

export const Process = {
  env: {},
  version: "",
  versions: {},
  platform: "browser",
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  cwd: () => "/",
};

/** Present so the reference resolves; deliberately not a Buffer implementation. */
export const Buffer = globalThis.Buffer ?? class Buffer {
  static from(value) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(value);
  }
  static isBuffer() { return false; }
};

export default Process;
