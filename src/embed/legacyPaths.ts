/**
 * File paths in Studio content that climb out of the activity's folder.
 *
 * Copying or pasting between activities in Studio's editor left file paths
 * like `../content/21078/images/x.jpeg` or `../21078/images/x.jpeg` in the
 * parameters, while also copying the file into the activity's own folder.
 * Studio's PHP core stripped those prefixes every time it filtered parameters
 * for display, so the player read `images/x.jpeg` from the activity's own
 * folder. Lumi does not, and H5P's player resolves the raw path to
 * `/h5p/content/content/21078/...`, which does not exist.
 *
 * Measured on the full corpus (2026-10-26): 499 such paths in 197 activities.
 * 491 had the file in the activity's own folder, 31 of them nowhere else.
 * The 8 remaining were already broken on Studio, or pointed at a full URL,
 * which stripping restores.
 *
 * Applied at render by `studioParams.ts`, as Studio did, so stored
 * parameters stay as imported.
 */

/** `../` once or twice, an optional `…content/`, a content id or `editor`, then the rest. */
const CLIMBING_PATH = /^(?:\.\.\/){1,2}(?:.*content\/)?(?:\d+|editor)\/(.+)$/;

/** The path H5P's PHP core would have served, or the input unchanged. */
export function stripClimbingPath(path: string): string {
  const match = CLIMBING_PATH.exec(path);
  return match ? match[1] : path;
}

