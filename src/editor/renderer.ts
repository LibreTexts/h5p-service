import type { IEditorModel } from "@lumieducation/h5p-server";
import type { AuthorDisplayOptions } from "../embed/displayOptions.js";
import { toScriptJson } from "../embed/renderer.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Served from `public/`, uncompiled, like embed.js. */
const AUTH_SCRIPT = "/h5p/editor-auth.js";

/**
 * Lumi 10 lists the image cropper's stylesheet from a newer H5P editor than
 * the pinned 1.25, which still crops with darkroom and ships no cropper.css.
 * Requesting it only produces a 404 and a console error.
 */
const MISSING_EDITOR_ASSET = /\/libs\/cropper\.css(\?|$)/;

/**
 * Runs first in the editor page. H5P's editor scripts are written for an
 * editor page at the top of the window: `h5peditor.js` copies
 * `window.parent.H5PEditor`, which on a top-level page is the page itself.
 * Framed by Conductor, the parent is another origin and the read throws,
 * taking every editor widget script on this page down with it. The editor's
 * inner iframe is unaffected; its parent is this page.
 *
 * So when the parent is cross-origin, keep it for editor-page.js, which needs
 * it to talk to Conductor, and point `window.parent` back at this page.
 * `parent` is one of the window properties HTML lets a page replace. This
 * makes the page behave exactly as it would top-level.
 */
const PARENT_SHIM =
  "(function(){var p=window.parent;window.__LIBRETEXTS_PARENT__=p;" +
  "if(p!==window){try{void p.H5PEditor;}catch(e){window.parent=window;}}})();";
const PAGE_SCRIPT = "/h5p/editor-page.js";

export type EditorPageSettings = {
  parentOrigins: string[];
  contentId: string | null;
  displayOptions: AuthorDisplayOptions | null;
};

/**
 * Renders the editor page served at `/h5p/{id}/edit` and `/h5p/new/edit`.
 *
 * Boots H5P's own editor the way Lumi's default editor renderer does, with
 * two differences. `editor-auth.js` is loaded first, in this page and as the
 * first asset of the editor's inner iframe, so every editor request carries
 * the capability token. And `editor-page.js` waits for Conductor to send that
 * token before starting the editor, then speaks the editor protocol.
 *
 * The page holds nothing secret and is served without authorization.
 */
export function renderEditorPage(model: IEditorModel, language: string, settings: EditorPageSettings): string {
  const integration: any = structuredClone(model.integration);
  const assets = integration.editor?.assets;
  if (assets && Array.isArray(assets.js) && !assets.js.includes(AUTH_SCRIPT)) {
    assets.js.unshift(AUTH_SCRIPT);
  }
  if (assets && Array.isArray(assets.css)) {
    assets.css = assets.css.filter((href: string) => !MISSING_EDITOR_ASSET.test(href));
  }

  const editorSettings = {
    parentOrigins: settings.parentOrigins,
    contentId: settings.contentId,
    displayOptions: settings.displayOptions,
    paramsUrl: settings.contentId ? `${model.urlGenerator.parameters()}/${settings.contentId}` : null,
    saveUrlBase: "/h5p",
  };

  const styles = model.styles
    .filter((href) => !MISSING_EDITOR_ASSET.test(href))
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`).join("\n    ");
  const scripts = model.scripts.map((src) => `<script src="${escapeHtml(src)}"></script>`).join("\n    ");

  return `<!doctype html>
<html lang="${escapeHtml(language)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>H5P editor</title>
    <script>window.H5PIntegration = ${toScriptJson(integration)};</script>
    <script>${PARENT_SHIM}</script>
    <script>window.__LIBRETEXTS_EDITOR__ = ${toScriptJson(editorSettings)};</script>
    <script src="${AUTH_SCRIPT}"></script>
    ${styles}
    ${scripts}
  </head>
  <body>
    <div class="h5p-create"><div class="h5p-editor"></div></div>
    <script src="${PAGE_SCRIPT}"></script>
  </body>
</html>`;
}
