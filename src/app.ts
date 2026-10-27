import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fileUpload from "express-fileupload";
import { h5pAjaxExpressRouter } from "@lumieducation/h5p-express";
import config from "./config.js";
import logger from "./logger.js";
import { anonymousUser, type H5PStack } from "./h5p.js";
import embedRouter from "./routes/embed.js";
import legacyRouter from "./routes/legacy.js";
import { createCapabilityVerifier } from "./auth/capabilityToken.js";
import { capabilityUserMiddleware } from "./auth/requestUser.js";
import authoringRouter from "./routes/authoring.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * The HTTP application, without listening. Split from index.ts so the
 * verification scripts can run the real middleware and routes against a test
 * stack.
 */
export function createApp(stack: H5PStack): express.Express {
  const app = express();

  // The H5P ajax router reads `req.user`. With authoring off (phase 1) every
  // request is anonymous and an Authorization header is ignored. With it on, a
  // request carrying a Conductor-signed capability token runs as that token's
  // user, and one without a header is still anonymous. Rights come from
  // `auth/CapabilityPermissionSystem.ts` either way.
  if (config.authoring.enabled) {
    app.use(capabilityUserMiddleware(createCapabilityVerifier(config.authoring.publicKeys)));
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

  app.get("/health", (_req, res) => {
    res.json({ healthy: true, service: "h5p-service" });
  });

  // Declared before the H5P ajax router so `/h5p/:contentId/embed` is not
  // swallowed by the router's own `/:contentId` content-file handling.
  app.use("/h5p", embedRouter(stack));

  // The embed client contract. Served from `public/` rather than compiled so it
  // stays readable as the interface document it is.
  app.use("/h5p", express.static(path.join(projectRoot, "public")));

  app.use(legacyRouter());

  /**
   * Core files, library files and content files, plus the editor's own routes
   * when authoring is on.
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
        routeGetContentFile: true,
        routeGetLibraryFile: true,
        routeGetDownload: true,
        routeGetParameters: true,
        routeEditorCoreFiles: config.authoring.enabled,
        routeGetAjax: config.authoring.enabled,
        routePostAjax: config.authoring.enabled,
        routeGetTemporaryContentFile: config.authoring.enabled,
        routeContentUserData: false,
        routeFinishedData: false,
      }
    )
  );

  return app;
}
