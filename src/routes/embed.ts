import { Router, type Request, type Response } from "express";
import type { IPlayerModel } from "@lumieducation/h5p-server";
import type { H5PStack } from "../h5p.js";
import { anonymousUser } from "../h5p.js";
import { renderEmbed, renderUnavailable } from "../embed/renderer.js";
import config from "../config.js";
import { childLogger } from "../logger.js";

const log = childLogger("embed");

/**
 * Serves the embed route published textbooks point at.
 *
 * The path shape `/h5p/:contentId/embed` is a public contract: it is baked into
 * every activity embed across the LibreTexts libraries and cannot change. The
 * `:contentId` is the integer Studio assigned, carried through migration.
 */
export default function embedRouter(stack: H5PStack): Router {
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
        // The player's renderer is configured once at startup to return the
        // model, so formatting here stays per-request.
        const model = (await stack.player.render(
          contentId,
          anonymousUser(),
          language,
          // Access is decided by Conductor, which owns the activity record.
          // Studio applied no check here at all; see `anonymousUser`.
          { ignoreUserPermissions: true }
        )) as IPlayerModel;

        res.status(200).type("html").send(renderEmbed(model, language));
      } catch (err) {
        // A missing or unreadable content id is an expected outcome for an
        // embed whose activity was deleted, not a server fault.
        log.warn({ err, contentId }, "Embed render failed");
        res.status(404).type("html").send(renderUnavailable());
      }
    }
  );

  return router;
}
