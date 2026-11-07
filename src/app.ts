import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fileUpload from "express-fileupload";
import { h5pAjaxExpressRouter } from "@lumieducation/h5p-express";
import config from "./config.js";
import logger from "./logger.js";
import { anonymousUser, type H5PStack } from "./h5p.js";
import embedRouter from "./routes/embed.js";
import fileRouter from "./routes/files.js";
import legacyRouter from "./routes/legacy.js";
import { createCapabilityVerifier } from "./auth/capabilityToken.js";
import { capabilityUserMiddleware } from "./auth/requestUser.js";
import { createReadGate } from "./auth/privateContent.js";
import authoringRouter from "./routes/authoring.js";
import { InFlightRequests, requestLog } from "./observability/requestLog.js";
import type { PoolMonitor } from "./observability/poolGauge.js";
import downloadRouter from "./routes/download.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * The HTTP application, without listening. Split from index.ts so the
 * verification scripts can run the real middleware and routes against a test
 * stack.
 *
 * `monitor` is optional for the same reason, so the scripts start no timers.
 * Without it /health never fails.
 */
export function createApp(
  stack: H5PStack,
  { inFlight = new InFlightRequests(), monitor }: { inFlight?: InFlightRequests; monitor?: PoolMonitor } = {}
): express.Express {
  const app = express();

  // First, so every request is counted while in flight, including ones the
  // auth middleware below rejects. See observability/requestLog.ts.
  app.use(requestLog(inFlight, { slowMs: config.observability.slowRequestMs }));

  // The H5P ajax router reads `req.user`. With authoring off (phase 1) every
  // request is anonymous and an Authorization header is ignored. With it on, a
  // request carrying a Conductor-signed capability token runs as that token's
  // user, and one without a header is still anonymous. Rights come from
  // `auth/CapabilityPermissionSystem.ts` either way.
  const verify = config.authoring.enabled ? createCapabilityVerifier(config.authoring.publicKeys) : undefined;
  const readGate = createReadGate({ enforced: config.privateContent.enforced, verify });
  if (config.privateContent.enforced) logger.info("Private content enforced");

  if (verify) {
    app.use(capabilityUserMiddleware(verify));
    logger.info({ keys: config.authoring.publicKeys.map((k) => k.kid) }, "Authoring enabled: capability tokens accepted");
  } else {
    app.use((req, _res, next) => {
      (req as any).user = anonymousUser();
      next();
    });
  }

  if (config.authoring.enabled) {
    // The editor's AJAX endpoint only serves the editor, which always holds a
    // token. Refusing anonymous calls here, before the body parsers below,
    // means nobody can make the service buffer a 100 MB upload just to be
    // told no by the permission system afterwards.
    app.use("/h5p/ajax", (req, res, next) => {
      if ((req as any).user?.capability) return next();
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "token_required" });
    });
    // Editor pages, save, allocate and delete. Before the global body parsers,
    // because the save route checks the token first and then parses its own,
    // larger, body.
    app.use("/h5p", authoringRouter(stack));
    logger.info({ parentOrigins: config.authoring.parentOrigins }, "Authoring routes mounted");
  }

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(fileUpload({ limits: { fileSize: 100 * 1024 * 1024 } }));

  // A 503 once any S3 pool has stayed full past S3_POOL_UNHEALTHY_AFTER_MS,
  // so the orchestrator replaces a task whose sockets are held. Before this,
  // /health stayed green while every upload and editor load failed.
  app.get("/health", (_req, res) => {
    const stuck = monitor?.stuck() ?? {};
    const healthy = Object.keys(stuck).length === 0;
    res.status(healthy ? 200 : 503).json({
      healthy,
      service: "h5p-service",
      stuck,
      s3Pools: Object.fromEntries(stack.pools.map((pool) => [pool.name, pool.stats()])),
      inFlight: inFlight.summary(),
    });
  });

  // Declared before the H5P ajax router so `/h5p/:contentId/embed` is not
  // swallowed by the router's own `/:contentId` content-file handling.
  app.use("/h5p", embedRouter(stack, readGate));

  // The embed client contract. Served from `public/` rather than compiled so it
  // stays readable as the interface document it is.
  app.use("/h5p", express.static(path.join(projectRoot, "public")));

  app.use(legacyRouter());

  // The .h5p download, replacing Lumi's, which could hold fifty S3 sockets
  // per abandoned export. See routes/download.ts.
  app.use(
    "/h5p",
    downloadRouter(stack, {
      idleTimeoutMs: config.s3.streamIdleTimeoutMs,
      maxConcurrent: config.download.maxConcurrent,
      readGate,
    })
  );

  // Lumi's parameters route, mounted below, cannot ask about private content,
  // so the check runs here first. A refusal is the same 404 as a missing id.
  app.get(`/h5p${stack.config.paramsUrl}/:contentId`, async (req, res, next) => {
    const { contentId } = req.params;
    try {
      if (!/^\d+$/.test(contentId)) return next();
      if (await readGate.allows(req, contentId, await stack.contentStorage.isPrivate(contentId))) return next();
      logger.info({ contentId }, "Parameters refused: private content");
      res.status(404).json({ message: "Content not found", errorCode: "content-not-found" });
    } catch (err) {
      next(err);
    }
  });

  // Library, content and temporary files, replacing Lumi's routes for them,
  // which can leave S3 sockets held forever. See routes/files.ts.
  app.use(
    "/h5p",
    fileRouter(stack, {
      idleTimeoutMs: config.s3.streamIdleTimeoutMs,
      temporaryFiles: config.authoring.enabled,
    })
  );

  /**
   * Core files, plus the editor's own routes when authoring is on.
   *
   * With authoring off, this is exactly phase 1: serving and embedding.
   * `routeCoreFiles` is what serves `h5p-resizer.js`, so it is required, not
   * optional. Learner state and results stay off either way; this service does
   * not store them.
   */
  app.use(
    "/h5p",
    h5pAjaxExpressRouter(
      stack.editor,
      config.h5p.corePath,
      config.h5p.editorPath,
      {
        handleErrors: true,
        routeCoreFiles: true,
        routeGetContentFile: false,
        routeGetLibraryFile: false,
        routeGetDownload: false,
        routeGetParameters: true,
        routeEditorCoreFiles: config.authoring.enabled,
        routeGetAjax: config.authoring.enabled,
        routePostAjax: config.authoring.enabled,
        routeGetTemporaryContentFile: false,
        routeContentUserData: false,
        routeFinishedData: false,
      }
    )
  );

  return app;
}
