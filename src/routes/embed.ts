import { Router, type Request, type Response } from "express";
import type { IPlayerModel } from "@lumieducation/h5p-server";
import type { H5PStack } from "../h5p.js";
import { anonymousUser } from "../h5p.js";
import { renderEmbed, renderUnavailable } from "../embed/renderer.js";
import { displayOptionsForView } from "../embed/displayOptions.js";
import config from "../config.js";
import { childLogger } from "../logger.js";
import type { ReadGate } from "../auth/privateContent.js";

const log = childLogger("embed");

/**
 * Serves the embed route published textbooks point at.
 *
 * The path shape `/h5p/:contentId/embed` is a public contract: it is baked into
 * every activity embed across the LibreTexts libraries and cannot change. The
 * `:contentId` is the integer Studio assigned, carried through migration.
 *
 * Private content needs a `view` or `edit` token in `?token=` (an iframe
 * cannot send a header) and otherwise gets the same 404 as a missing id. See
 * `auth/privateContent.ts`.
 */
export default function embedRouter(stack: H5PStack, readGate: ReadGate): Router {
  const router = Router();

  router.get(
    "/:contentId/embed",
    async (req: Request, res: Response): Promise<void> => {
      const { contentId } = req.params;

      // Studio's route only matched digits; anything else was a 404 from the
      // router rather than a placeholder page.
      if (!/^\d+$/.test(contentId)) {
        res.status(404).type("html").send(renderUnavailable());
        return;
      }

      // The page is framed cross-origin by design, so the default
      // `frame-ancestors 'self'` would break every published embed.
      //
      // `config.embed.frameAncestors` is safe to interpolate because
      // `requiredCspSourceList` in `config/env.ts` rebuilds it from validated
      // tokens at startup, so CR, LF and `;` cannot reach this header. Do not
      // replace it with a raw environment read.
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors ${config.embed.frameAncestors}`
      );

      const language =
        typeof req.query.lang === "string" ? req.query.lang : "en";

      try {
        // Lumi's player turns every failure to read parameters or metadata,
        // Mongo errors included, into `h5p-player:content-missing`. Checking
        // first separates an id with no content, which is routine for deleted
        // activities and probes, from a store fault, which reaches the catch
        // below with its real cause.
        if (!(await stack.contentStorage.contentExists(contentId))) {
          log.info(
            { contentId, referer: req.get("referer"), userAgent: req.get("user-agent") },
            "Embed requested for unknown content"
          );
          res.status(404).type("html").send(renderUnavailable());
          return;
        }

        const settings = await stack.contentStorage.getEmbedSettings(contentId);
        if (!(await readGate.allows(req, contentId, settings.private, { allowQueryToken: true }))) {
          log.info({ contentId, referer: req.get("referer") }, "Embed refused: private content");
          res.status(404).type("html").send(renderUnavailable());
          return;
        }
        if (settings.private) {
          // Opened with a token in the URL: keep the page out of every cache,
          // and keep the URL out of the Referer its file requests send.
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Referrer-Policy", "no-referrer");
        }

        // The player's renderer is configured once at startup to return the
        // model, so formatting here stays per-request.
        // The action bar buttons the author chose in Studio. See
        // embed/displayOptions.ts for why this cannot be left to Lumi's defaults.
        const displayOptions = displayOptionsForView(settings.disabledFeatures);
        const model = (await stack.player.render(
          contentId,
          anonymousUser(),
          language,
          // Access was decided above, from the private flag Conductor sets.
          // Public content stays open, as Studio left it; see `anonymousUser`.
          { ignoreUserPermissions: true, ...displayOptions }
        )) as IPlayerModel;

        res
          .status(200)
          .type("html")
          .send(renderEmbed(model, language, { embedCode: displayOptions.showEmbedButton }));
      } catch (err) {
        // The content exists, so this is a store or library fault the reader
        // sees as a broken embed.
        log.error({ err, contentId }, "Embed render failed");
        res.status(404).type("html").send(renderUnavailable());
      }
    }
  );

  return router;
}
