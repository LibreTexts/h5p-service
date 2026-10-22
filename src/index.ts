import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fileUpload from "express-fileupload";
import { h5pAjaxExpressRouter } from "@lumieducation/h5p-express";
import config from "./config.js";
import logger from "./logger.js";
import { anonymousUser, buildH5P } from "./h5p.js";
import embedRouter from "./routes/embed.js";
import legacyRouter from "./routes/legacy.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function main(): Promise<void> {
  const stack = await buildH5P();
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(fileUpload({ limits: { fileSize: 100 * 1024 * 1024 } }));

  // The H5P ajax router reads `req.user`. Phase 1 serves content anonymously;
  // phase 2 replaces this with the LibreOne-backed identity.
  app.use((req, _res, next) => {
    (req as any).user = anonymousUser();
    next();
  });

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
   * Core files, library files and content files.
   *
   * The editor ajax routes stay off for phase 1: this service serves and embeds
   * existing activities, and authoring arrives in phase 2. `routeCoreFiles` is
   * what serves `h5p-resizer.js`, so it is required, not optional.
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
        routeEditorCoreFiles: false,
        routeGetAjax: false,
        routePostAjax: false,
        routeContentUserData: false,
        routeFinishedData: false,
        routeGetTemporaryContentFile: false,
      }
    )
  );

  app.listen(config.port, () => {
    logger.info(
      { port: config.port, baseUrl: config.baseUrl, env: config.nodeEnv },
      "h5p-service listening"
    );
  });
}

main().catch((err) => {
  logger.fatal({ err }, "h5p-service failed to start");
  process.exit(1);
});
