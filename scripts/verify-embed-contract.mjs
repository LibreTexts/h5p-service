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
const { displayOptionsForView } = await import("../dist/embed/displayOptions.js");
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

// `custom` is in every published embed snippet. `contrib` is hardcoded in
// ADAPT's H5PResizer.js. Literal strings rather than the router's own list, so
// a path dropped from legacy.ts fails here instead of passing silently.
for (const variant of ["custom", "contrib"]) {
  const legacy = await fetch(
    `${base}/modules/${variant}/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js`,
    { redirect: "manual" }
  );
  check(`legacy ${variant} resizer path returns 301`, legacy.status === 301, `got ${legacy.status}`);
  check(
    `legacy ${variant} resizer redirects to core path`,
    legacy.headers.get("location") === "/h5p/core/js/h5p-resizer.js",
    legacy.headers.get("location")
  );
}

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

// The action bar. Lumi defaults every option off, which hid the bar, and the
// license it carries, on every migrated embed. Studio's disabled_features bits:
// 1 frame, 2 download, 4 embed, 8 copyright.
{
  const all = displayOptionsForView(undefined);
  check(
    "action bar defaults on for content with no stored options",
    all.showFrame && all.showDownloadButton && all.showEmbedButton && all.showLicenseButton && all.showH5PIcon
  );
  check("copy button stays off for anonymous viewers", all.showCopyButton === false);
  const noDownloadNoEmbed = displayOptionsForView(2 | 4);
  check(
    "disabled_features 6 hides download and embed only",
    noDownloadNoEmbed.showFrame && !noDownloadNoEmbed.showDownloadButton &&
      !noDownloadNoEmbed.showEmbedButton && noDownloadNoEmbed.showLicenseButton
  );
  check("disabled_features 1 hides the frame", displayOptionsForView(1).showFrame === false);
  check("disabled_features 8 hides the license button", displayOptionsForView(8).showLicenseButton === false);
  check("the H5P icon ignores bit 16, as H5P core does", displayOptionsForView(16).showH5PIcon === true);

  const withCode = renderEmbed(
    {
      ...model,
      integration: {
        ...model.integration,
        contents: { "cid-12345": { metadata: { title: 'Quiz "A" <b>', defaultLanguage: "es" } } },
      },
    },
    "en",
    { embedCode: true }
  );
  // JSON.parse undoes the renderer's script-safe escaping itself.
  const marker = "window.H5PIntegration = ";
  const start = withCode.indexOf(marker) + marker.length;
  const integration = JSON.parse(withCode.slice(start, withCode.indexOf(";</script>", start)));
  const content = integration.contents["cid-12345"];
  check(
    "Embed button code points at the public embed URL",
    content.embedCode?.includes(`src="${process.env.BASE_URL}/h5p/12345/embed"`),
    content.embedCode
  );
  check("Embed button code keeps H5P's size placeholders", content.embedCode?.includes('width=":w" height=":h"'));
  check("Embed button code escapes the title", content.embedCode?.includes('title="Quiz &quot;A&quot; &lt;b&gt;"'), content.embedCode);
  check("Embed button code carries the content language", content.embedCode?.includes('lang="es"'));
  check(
    "Embed button resize code uses the canonical resizer path",
    content.resizeCode === `<script src="${process.env.BASE_URL}/h5p/core/js/h5p-resizer.js" charset="UTF-8"></script>`,
    content.resizeCode
  );
  check("no embed code when the Embed button is hidden", !html.includes("embedCode"));

  // Studio preloaded an empty state, so H5P never requested
  // /h5p/contentUserData/{id}/state/0, which this service does not serve.
  check(
    "an empty saved state is preloaded, as Studio did",
    JSON.stringify(content.contentUserData) === JSON.stringify([{ state: "{}" }]),
    content.contentUserData
  );
  const withState = renderEmbed(
    {
      ...model,
      integration: {
        ...model.integration,
        contents: { "cid-12345": { metadata: {}, contentUserData: [{ state: '{"a":1}' }] } },
      },
    },
    "en"
  );
  check("a state already supplied is kept", withState.includes('"state":"{\\"a\\":1}"'));

  // Studio's PHP core served files referenced from other activities' folders
  // out of the activity's own folder. 197 migrated activities depend on it.
  const { stripClimbingPath } = await import("../dist/embed/legacyPaths.js");
  for (const [input, expected] of [
    ["../content/21078/images/a.jpeg", "images/a.jpeg"],
    ["../21078/images/a.jpeg", "images/a.jpeg"],
    ["../../content/21078/videos/b.mp4", "videos/b.mp4"],
    ["../editor/images/c.png", "images/c.png"],
    ["../10421/https://example.org/d.png", "https://example.org/d.png"],
    ["images/a.jpeg", "images/a.jpeg"],
    ["https://example.org/../e.png", "https://example.org/../e.png"],
    ["../not-an-id/f.png", "../not-an-id/f.png"],
  ]) {
    check(`climbing path ${input} is served as ${expected}`, stripClimbingPath(input) === expected, stripClimbingPath(input));
  }
  const climbing = renderEmbed(
    {
      ...model,
      integration: {
        ...model.integration,
        contents: {
          "cid-12345": {
            metadata: {},
            jsonContent: JSON.stringify({ image: { path: "../content/21078/images/a.jpeg" }, text: "../content/9/not-a-path" }),
          },
        },
      },
    },
    "en"
  );
  check("the embed page serves climbing paths from the activity's own folder", climbing.includes('\\"path\\":\\"images/a.jpeg\\"'));
  check("only `path` values are rewritten", climbing.includes("../content/9/not-a-path"));

  // Studio's validator removed library slots left empty. H5P.Column throws on
  // one, blanking the activity and any Interactive Book chapter built on it.
  const { studioFilteredParams } = await import("../dist/embed/studioParams.js");
  const filtered = JSON.parse(
    studioFilteredParams(
      JSON.stringify({
        content: [
          { content: { params: {} }, useSeparator: "auto" },
          { content: { library: "H5P.Text 1.1", params: { text: "kept" }, subContentId: "a" } },
        ],
        media: { type: { params: {}, metadata: {} } },
        questions: [{ params: {} }, { library: "H5P.MultiChoice 1.16", params: {} }],
        other: { dom: "<p></p>", params: {} },
      })
    )
  );
  check("an empty library slot is removed from its parent", filtered.content[0].content === undefined && filtered.content[0].useSeparator === "auto");
  check("a slot with a library is kept", filtered.content[1].content?.params?.text === "kept");
  check("an empty slot with metadata is removed", filtered.media.type === undefined);
  check("an empty slot in a list is dropped, not left as null", filtered.questions.length === 1 && filtered.questions[0].library === "H5P.MultiChoice 1.16");
  check("objects that are not library slots are kept", filtered.other?.dom === "<p></p>");
  const untouched = JSON.stringify({ a: { library: "H5P.Text 1.1", params: {} } });
  check("parameters needing no change are returned as the same string", studioFilteredParams(untouched) === untouched);
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
