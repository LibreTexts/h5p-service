import type { IPlayerModel } from "@lumieducation/h5p-server";
import config from "../config.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serializes a value for embedding in a <script> block.
 *
 * `</script>` inside the JSON would close the tag early, so the forward slash is
 * escaped. `<!--` would open an HTML comment in legacy parsers.
 */
function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Renders the standalone embed document served at `/h5p/:contentId/embed`.
 *
 * `@lumieducation/h5p-server` does not ship an embed route, so this stands in
 * for H5P Core's `embed.php`, which is what Studio rendered. The markup is kept
 * close to that output on purpose: published textbook pages and ADAPT both
 * interact with the resulting DOM, including the `.h5p-actions` bar the embed
 * script adjusts and the `.h5p-content` mount point the H5P runtime expects.
 */
export function renderEmbed(model: IPlayerModel, language: string): string {
  const contentId = String(model.contentId);
  const title =
    (model.integration?.contents?.[`cid-${contentId}`] as any)?.metadata
      ?.title ?? `H5P Content ${contentId}`;

  const scripts = model.scripts
    .map((src) => `<script src="${escapeHtml(src)}"></script>`)
    .join("\n    ");
  const styles = model.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`)
    .join("\n    ");

  /**
   * The embed client's configuration channel.
   *
   * `public/embed.js` is served statically and never compiled, so it cannot
   * read the environment. Everything deployment-specific it needs arrives
   * through this object. Adding a field here is the only way to make a value
   * in that file configurable.
   */
  const embedSettings = {
    allowedParentOrigins: config.embed.allowedParentOrigins,
    adaptReferrers: config.embed.adaptReferrers,
    trustedParentHosts: config.embed.trustedParentHosts,
    badge: config.embed.badge,
  };

  return `<!doctype html>
<html class="h5p-iframe" lang="${escapeHtml(language)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${styles}
    <script>window.H5PIntegration = ${toScriptJson(model.integration)};</script>
    <script>window.__LIBRETEXTS_EMBED__ = ${toScriptJson(embedSettings)};</script>
    ${scripts}
  </head>
  <body>
    <div class="h5p-content" data-content-id="${escapeHtml(contentId)}"></div>
    <!-- Relative and same-origin on purpose: a misconfigured BASE_URL must not
         be able to turn the embed contract script into a cross-origin load. -->
    <script src="/h5p/embed.js"></script>
  </body>
</html>
`;
}

/**
 * The document served when a content id does not resolve.
 *
 * Studio never 404'd a missing embed; it rendered a placeholder so a textbook
 * page showed a message rather than a broken frame. That behaviour is kept, but
 * the status code is now honest so monitoring can see it.
 */
export function renderUnavailable(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Content unavailable</title>
    <style>
      body {
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #1b1b1b;
        background: #fff;
      }
      p { margin: 0; padding: 1rem; text-align: center; }
    </style>
  </head>
  <body>
    <p>Content unavailable.</p>
  </body>
</html>
`;
}
