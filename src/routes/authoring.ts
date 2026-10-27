import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { H5PStack } from "../h5p.js";
import config from "../config.js";
import { childLogger } from "../logger.js";
import type { CapabilityUser } from "../auth/CapabilityPermissionSystem.js";
import type { CapabilityAction } from "../auth/capabilityToken.js";
import { renderEditorPage } from "../editor/renderer.js";
import { authorDisplayOptions, disabledFeaturesFrom } from "../embed/displayOptions.js";

const log = childLogger("authoring");

/** Studio's ids and everything allocated since: plain positive integers. */
const CONTENT_ID = "([1-9]\\d{0,15})";

/**
 * Largest save body accepted. Interactive Books and Course Presentations carry
 * several megabytes of parameters; media files travel separately as uploads.
 */
const SAVE_BODY_LIMIT = "25mb";

/** "H5P.MultiChoice 1.16" as Lumi's library name, or null. */
function parseUbername(value: string): { machineName: string; majorVersion: number; minorVersion: number } | null {
  const m = /^([A-Za-z][\w.-]*) (\d+)\.(\d+)$/.exec(value);
  return m ? { machineName: m[1], majorVersion: Number(m[2]), minorVersion: Number(m[3]) } : null;
}

/** The user set by the request-user middleware in index.ts. */
function userOf(req: Request): CapabilityUser | undefined {
  return (req as unknown as { user?: CapabilityUser }).user;
}

/**
 * Refuses the request unless it carries a capability granting `action`, and,
 * when `matchParam` is given, scoped to the content id in that route
 * parameter. Runs before any body is parsed, so an anonymous caller cannot
 * make the service parse a large body.
 */
function requireCapability(action: CapabilityAction, matchParam?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const capability = userOf(req)?.capability;
    if (!capability) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "token_required" });
      return;
    }
    const scoped = matchParam === undefined || capability.contentId === req.params[matchParam];
    if (!capability.actions.has(action) || !scoped) {
      log.warn(
        { path: req.path, sub: capability.subject, jti: capability.tokenId, action },
        "Capability does not grant this request"
      );
      res.status(403).json({ error: "insufficient_scope" });
      return;
    }
    next();
  };
}

/**
 * Authoring routes, mounted under /h5p only when `AUTHORING_ENABLED` is on.
 *
 * - `GET /new/edit`, `GET /{id}/edit`: the editor page Conductor frames.
 * - `POST /{id}/save`: saves the editor's content, and the author's display
 *   options, under an `edit` token for that id.
 * - `POST /service/allocate`: takes the next content id, under an `allocate`
 *   token. Server to server, from Conductor.
 * - `DELETE /service/content/{id}`: deletes content and its files, under a
 *   `delete` token for that id. Server to server, from Conductor.
 *
 * The editor's own AJAX routes come from Lumi's router, switched on by the
 * same setting in index.ts. Every write is checked again by
 * CapabilityPermissionSystem inside Lumi; the checks here make the failure a
 * clean 401 or 403 before any work starts.
 */
export default function authoringRouter(stack: H5PStack): Router {
  const router = Router();
  const frameAncestors = config.authoring.parentOrigins.join(" ");

  async function editorPage(req: Request, res: Response, contentId: string | null): Promise<void> {
    const language = typeof req.query.lang === "string" && /^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(req.query.lang) ? req.query.lang : "en";
    try {
      if (contentId && !(await stack.contentStorage.contentExists(contentId))) {
        res.status(404).type("text").send("Not found");
        return;
      }
      const model = (await stack.editor.render(contentId ?? (undefined as any), language, userOf(req) as any)) as any;
      const displayOptions = contentId
        ? authorDisplayOptions(await stack.contentStorage.getDisabledFeatures(contentId))
        : authorDisplayOptions(undefined);
      // Only Conductor may frame the editor. Embeds keep the wider policy.
      res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
      res.setHeader("Cache-Control", "no-store");
      res
        .status(200)
        .type("html")
        .send(renderEditorPage(model, language, { parentOrigins: config.authoring.parentOrigins, contentId, displayOptions }));
    } catch (err) {
      log.error({ err, contentId }, "Editor page failed");
      res.status(500).type("text").send("The editor could not be loaded.");
    }
  }

  router.get("/new/edit", (req, res) => editorPage(req, res, null));
  router.get(`/:contentId${CONTENT_ID}/edit`, (req, res) => editorPage(req, res, req.params.contentId));

  router.post(
    `/:contentId${CONTENT_ID}/save`,
    requireCapability("edit", "contentId"),
    express.json({ limit: SAVE_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const { contentId } = req.params;
      const { library, params, displayOptions } = req.body ?? {};
      if (typeof library !== "string" || !params || typeof params !== "object" || !params.params || !params.metadata) {
        res.status(400).json({ error: "library, params.params and params.metadata are required" });
        return;
      }
      let disabledFeatures: number | undefined;
      if (displayOptions !== undefined) {
        try {
          disabledFeatures = disabledFeaturesFrom(displayOptions);
        } catch (err: any) {
          res.status(400).json({ error: err.message });
          return;
        }
      }
      const user = userOf(req) as CapabilityUser;

      // A new activity's first save goes into the id Conductor allocated, which
      // has no content yet. Lumi treats any save with an id as an update and
      // starts by reading the previous version, so give it an empty one: the
      // right main library and no parameters. Removed again if the save fails,
      // so a failed first save never leaves half-made content behind.
      let placeholder = false;
      if (!(await stack.contentStorage.contentExists(contentId))) {
        const main = parseUbername(library);
        if (!main) {
          res.status(400).json({ error: "library must look like \"H5P.Name 1.2\"" });
          return;
        }
        await stack.contentStorage.addContent(
          {
            title: String(params.metadata.title || "Untitled"),
            mainLibrary: main.machineName,
            preloadedDependencies: [main],
            license: "U",
            embedTypes: ["iframe"],
            language: "en",
            defaultLanguage: "en",
          } as any,
          {},
          user,
          contentId
        );
        placeholder = true;
      }

      try {
        const saved = await stack.editor.saveOrUpdateContentReturnMetaData(
          contentId,
          params.params,
          params.metadata,
          library,
          user
        );
        if (disabledFeatures !== undefined) {
          await stack.contentStorage.setDisabledFeatures(contentId, disabledFeatures);
        }
        const stored = await stack.contentStorage.getDisabledFeatures(contentId);
        log.info({ contentId, sub: user.capability?.subject, jti: user.capability?.tokenId }, "Content saved");
        res.json({
          contentId: saved.id,
          title: saved.metadata.title,
          library,
          license: saved.metadata.license,
          licenseVersion: saved.metadata.licenseVersion,
          authors: saved.metadata.authors ?? [],
          displayOptions: authorDisplayOptions(stored),
        });
      } catch (err: any) {
        const status = typeof err?.httpStatusCode === "number" ? err.httpStatusCode : 500;
        log.warn({ err, contentId, sub: user.capability?.subject }, "Content save failed");
        if (placeholder) {
          await stack.contentStorage.deleteContent(contentId).catch((cleanupErr: unknown) =>
            log.error({ err: cleanupErr, contentId }, "Could not remove the placeholder after a failed first save")
          );
        }
        res.status(status).json({ error: err?.errorId || "save_failed" });
      }
    }
  );

  router.post("/service/allocate", requireCapability("allocate"), async (req: Request, res: Response) => {
    const user = userOf(req) as CapabilityUser;
    try {
      const contentId = await stack.contentStorage.allocateContentId();
      log.info({ contentId, sub: user.capability?.subject, jti: user.capability?.tokenId }, "Content id allocated");
      res.status(201).json({ contentId });
    } catch (err) {
      log.error({ err }, "Content id allocation failed");
      res.status(500).json({ error: "allocation_failed" });
    }
  });

  router.delete(
    `/service/content/:contentId${CONTENT_ID}`,
    requireCapability("delete", "contentId"),
    async (req: Request, res: Response) => {
      const { contentId } = req.params;
      const user = userOf(req) as CapabilityUser;
      try {
        if (!(await stack.contentStorage.contentExists(contentId))) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        await stack.editor.deleteContent(contentId, user);
        log.info({ contentId, sub: user.capability?.subject, jti: user.capability?.tokenId }, "Content deleted");
        res.status(204).end();
      } catch (err: any) {
        const status = typeof err?.httpStatusCode === "number" ? err.httpStatusCode : 500;
        log.error({ err, contentId }, "Content delete failed");
        res.status(status).json({ error: err?.errorId || "delete_failed" });
      }
    }
  );

  return router;
}
