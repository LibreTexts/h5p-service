import { stripClimbingPath } from "./legacyPaths.js";

/**
 * Content parameters as Studio served them to the player.
 *
 * Studio's PHP core ran every activity's parameters through its content
 * validator before rendering, and two of the validator's side effects are
 * load-bearing for migrated content. Lumi serves stored parameters as they
 * are, so this reproduces both:
 *
 * - File paths that climb into another activity's folder are served from the
 *   activity's own folder. See `legacyPaths.ts`.
 * - A library slot the author left empty (`{"params":{}}`, no `library`) is
 *   removed. Most content types tolerate the empty slot, but H5P.Column with
 *   separators on reads `library.split` and throws, which blanks the whole
 *   activity and every Interactive Book built on it. Measured 2026-10-26:
 *   49,343 empty slots in 20,675 activities.
 *
 * Applied at render, as Studio did, so stored parameters stay as imported.
 */

/** Keys a library slot can carry besides `library`. */
const LIBRARY_SLOT_KEYS = new Set(["params", "subContentId", "metadata"]);

/** A library slot with no library chosen: `params` present, `library` absent, nothing else. */
function isEmptyLibrarySlot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes("params") && keys.every((k) => LIBRARY_SLOT_KEYS.has(k));
}

function filter(value: unknown, key: string | undefined, changed: { yes: boolean }): unknown {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (isEmptyLibrarySlot(item)) {
        changed.yes = true;
        continue;
      }
      out.push(filter(item, undefined, changed));
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isEmptyLibrarySlot(v)) {
        changed.yes = true;
        continue;
      }
      out[k] = filter(v, k, changed);
    }
    return out;
  }
  if (key === "path" && typeof value === "string" && value.startsWith("../")) {
    const stripped = stripClimbingPath(value);
    if (stripped !== value) {
      changed.yes = true;
      return stripped;
    }
  }
  return value;
}

/**
 * Applies Studio's render-time filtering to serialized parameters. Returns the
 * input string itself when nothing changed.
 */
export function studioFilteredParams(json: string): string {
  if (!json.includes('"../') && !json.includes('"params"')) return json;
  const changed = { yes: false };
  const filtered = filter(JSON.parse(json), undefined, changed);
  return changed.yes ? JSON.stringify(filtered) : json;
}
