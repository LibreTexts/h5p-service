/**
 * Exercises the parts of the embed contract that need no database:
 * the legacy resizer redirect, the resizer file itself, the embed script, and
 * the rendered embed document.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test fixtures, not defaults. `src/config/env.ts` deliberately has no default
// for any of these, so the harness has to supply its own. `||=` rather than `=`
// so an operator can point the harness at real configuration to test it.
//
// The embed values are intentionally not LibreTexts hosts: the assertions below
// prove that configuration reaches the page, which a real-looking value that
// also appears elsewhere in the markup would not.
process.env.MONGODB_URL ||= "mongodb://unused";
process.env.S3_CONTENT_BUCKET ||= "unused";
process.env.S3_LIBRARY_BUCKET ||= "unused";
process.env.S3_TEMPORARY_BUCKET ||= "unused";
process.env.AWS_REGION ||= "us-west-2";
process.env.BASE_URL ||= "https://verify.example.test";
process.env.ALLOWED_EMBED_PARENT_ORIGINS ||= "https://parent.example.test";
process.env.EMBED_FRAME_ANCESTORS ||= "https://*.example.test";
process.env.EMBED_ADAPT_REFERRERS ||= "https://adapt.example.test";
process.env.EMBED_TRUSTED_PARENT_HOSTS ||= "trusted.example.test";
process.env.EMBED_BADGE_HREF ||= "https://badge.example.test/";
process.env.EMBED_BADGE_LOGO_URL ||= "https://cdn.example.test/logo.png";
process.env.EMBED_BADGE_LABEL ||= "Powered by Example";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { renderEmbed } = await import("../dist/embed/renderer.js");
const { requiredCspSourceList } = await import("../dist/config/env.js");
const config = (await import("../dist/config.js")).default;
const legacyRouter = (await import("../dist/routes/legacy.js")).default;

const app = express();
app.use("/h5p", express.static(path.join(root, "public")));
app.use("/h5p/core", express.static(path.join(root, "h5p/core")));
app.use(legacyRouter());

// A model shaped like what H5PPlayer.render returns.
const model = {
  contentId: "12345",
  dependencies: [],
  downloadPath: "",
  embedTypes: ["iframe"],
  scripts: ["/h5p/core/js/h5p.js"],
  styles: ["/h5p/core/styles/h5p.css"],
  translations: {},
  user: {},
  integration: {
    baseUrl: "https://studio.libretexts.org",
    contents: { "cid-12345": { metadata: { title: "Photosynthesis Quiz" } } },
  },
};
app.get("/h5p/:id/embed", (_req, res) =>
  res.type("html").send(renderEmbed(model, "en"))
);

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
}

const legacy = await fetch(
  `${base}/modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js`,
  { redirect: "manual" }
);
check("legacy resizer path returns 301", legacy.status === 301, `got ${legacy.status}`);
check(
  "legacy resizer redirects to core path",
  legacy.headers.get("location") === "/h5p/core/js/h5p-resizer.js",
  legacy.headers.get("location")
);

const resizer = await fetch(`${base}/h5p/core/js/h5p-resizer.js`);
const resizerBody = await resizer.text();
check("resizer is served", resizer.status === 200, `got ${resizer.status}`);
check(
  "resizer is the real H5P resizer",
  resizerBody.includes("h5p") && resizerBody.includes("resize"),
  `${resizerBody.length} bytes`
);

const script = await fetch(`${base}/h5p/embed.js`);
const scriptBody = await script.text();
check("embed contract script is served", script.status === 200, `got ${script.status}`);
for (const token of [
  'postToParent(JSON.stringify("loaded"))',
  'postToParent("loaded")',
  '"updated elements"',
  '"updated templates"',
  "isAllowedOrigin",
  "H5P.externalDispatcher",
]) {
  check(`embed script contains ${token}`, scriptBody.includes(token));
}

const embed = await fetch(`${base}/h5p/12345/embed`);
const html = await embed.text();
check("embed renders", embed.status === 200, `got ${embed.status}`);
for (const token of [
  '<html class="h5p-iframe" lang="en">',
  '<div class="h5p-content" data-content-id="12345">',
  "window.H5PIntegration =",
  "window.__LIBRETEXTS_EMBED__ =",
  '<script src="/h5p/embed.js">',
  "Photosynthesis Quiz",
]) {
  check(`embed html contains ${token}`, html.includes(token));
}

// Each of these proves a configured value reaches the embed client, which is
// the only channel `public/embed.js` has -- it is served statically and cannot
// read the environment.
for (const [name, value] of [
  ["ALLOWED_EMBED_PARENT_ORIGINS", process.env.ALLOWED_EMBED_PARENT_ORIGINS],
  ["EMBED_ADAPT_REFERRERS", process.env.EMBED_ADAPT_REFERRERS],
  ["EMBED_TRUSTED_PARENT_HOSTS", process.env.EMBED_TRUSTED_PARENT_HOSTS],
  ["EMBED_BADGE_HREF", process.env.EMBED_BADGE_HREF],
  ["EMBED_BADGE_LOGO_URL", process.env.EMBED_BADGE_LOGO_URL],
  ["EMBED_BADGE_LABEL", process.env.EMBED_BADGE_LABEL],
]) {
  check(`${name} reaches the embed page`, html.includes(value), value);
}

// The real embed route sets `frame-ancestors` from this value; the stub route
// above cannot, because the live route needs the H5P stack and a database.
// Assert the configured value survives validation instead.
check(
  "frame-ancestors is read from configuration",
  config.embed.frameAncestors === process.env.EMBED_FRAME_ANCESTORS,
  config.embed.frameAncestors
);

// That value is interpolated into a response header. These assert the
// validator that makes it safe, so the guarantee cannot regress silently.
for (const bad of [
  "https://x.example.test\nX-Injected: 1",
  "https://x.example.test; script-src *",
  "https://a.example.test,https://b.example.test",
  "javascript:alert(1)",
  " ",
]) {
  let threw = false;
  process.env.__CSP_PROBE = bad;
  try {
    requiredCspSourceList("__CSP_PROBE");
  } catch {
    threw = true;
  }
  check(`CSP validator rejects ${JSON.stringify(bad)}`, threw);
}
delete process.env.__CSP_PROBE;

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
// Set the code and let the loop drain. Calling process.exit() with the server
// still open trips a libuv assertion on Windows and reads as a CI failure.
process.exitCode = failures === 0 ? 0 : 1;
server.close();
