import { Router } from "express";

/**
 * Drupal-shaped paths that appear verbatim in published LibreTexts pages and in
 * ADAPT.
 *
 * Studio built the resizer URL from the module's install location, so every
 * embed snippet ever generated carries this exact path:
 *
 *   /modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js
 *
 * ADAPT hardcodes the `contrib` variant instead, in
 * `resources/js/helpers/H5PResizer.js`, and loads it on every page that shows
 * an H5P question. Without it, ADAPT has no working iframe sizer and every
 * activity renders clipped. Both paths are permanent.
 *
 * The file itself is served by the H5P ajax router under the core path, so
 * these only have to redirect. A 301 is used because the target is permanent
 * and we want intermediaries to cache it; the resizer is requested once per
 * embedded activity per page.
 */
export const LEGACY_RESIZER_PATHS = [
  "/modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js",
  "/modules/contrib/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js",
];

export default function legacyRouter(): Router {
  const router = Router();

  router.get(LEGACY_RESIZER_PATHS, (_req, res) => {
    res.redirect(301, "/h5p/core/js/h5p-resizer.js");
  });

  return router;
}
