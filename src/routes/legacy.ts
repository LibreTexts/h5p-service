import { Router } from "express";

/**
 * Drupal-shaped paths that appear verbatim in published LibreTexts pages.
 *
 * Studio built the resizer URL from the module's install location, so every
 * embed snippet ever generated carries this exact path:
 *
 *   /modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js
 *
 * The file itself is served by the H5P ajax router under the core path, so this
 * only has to redirect. A 301 is used because the target is permanent and we
 * want intermediaries to cache it; the resizer is requested once per embedded
 * activity per page.
 */
const LEGACY_RESIZER_PATH =
  "/modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js";

export default function legacyRouter(): Router {
  const router = Router();

  router.get(LEGACY_RESIZER_PATH, (_req, res) => {
    res.redirect(301, "/h5p/core/js/h5p-resizer.js");
  });

  return router;
}
