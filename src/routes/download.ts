import { createRequire } from "node:module";
import { pipeline, Readable } from "node:stream";
import { Router, type ErrorRequestHandler } from "express";
import yazl from "yazl";
import { errorHandler } from "@lumieducation/h5p-express/build/expressErrorHandler.js";
import {
  ContentFileScanner,
  ContentPermission,
  H5pError,
  LibraryName,
  utils,
  type ContentParameters,
  type IContentMetadata,
  type ILibraryName,
  type ILibraryStorage,
  type IUser,
} from "@lumieducation/h5p-server";
import type { H5PStack } from "../h5p.js";
import { childLogger } from "../logger.js";

const log = childLogger("download");

// Not exported from the package entry point.
const require = createRequire(import.meta.url);
const DependencyGetter: new (storage: ILibraryStorage) => {
  getDependentLibraries(
    libraries: ILibraryName[],
    options: { editor?: boolean; preloaded?: boolean }
  ): Promise<ILibraryName[]>;
} = require("@lumieducation/h5p-server/build/src/DependencyGetter.js").default;
const generateFilename: (
  filename: string,
  sanitize: (filename: string) => string,
  exists: (filename: string) => Promise<boolean>
) => Promise<string> = require("@lumieducation/h5p-server/build/src/helpers/FilenameGenerator.js").default;

/** Lumi's default for `exportMaxContentPathLength`. */
const MAX_CONTENT_PATH_LENGTH = 255;

/**
 * The .h5p download, in place of Lumi's `GET /download/:contentId`. Derived
 * from Lumi's `PackageExporter` (GPL-3.0-or-later): same permission check,
 * same package layout, same filename shortening.
 *
 * Upstream awaits `getFileStream` for every content and library file in turn
 * and hands each open stream to yazl, which reads them one at a time. A
 * package with hundreds of library files therefore holds up to fifty S3
 * sockets at once, and when the client leaves, nothing reads or destroys them
 * and the export never finishes. Crawlers fetch these links, so the stream
 * pool filled in production.
 *
 * Here each file is opened only when yazl reaches it, so an export holds at
 * most one S3 socket. Everything is destroyed when the client leaves or the
 * export makes no progress for `idleTimeoutMs`, and at most `maxConcurrent`
 * exports run at once. The listing calls run before any header is sent, so a
 * failure there is an ordinary H5P error response.
 */
export default function downloadRouter(
  stack: H5PStack,
  { idleTimeoutMs, maxConcurrent }: { idleTimeoutMs: number; maxConcurrent: number }
): Router {
  const router = Router();
  let active = 0;

  router.get(`${stack.config.downloadUrl}/:contentId`, (req, res, next) => {
    const contentId = req.params.contentId;
    if (active >= maxConcurrent) {
      log.warn({ contentId, active, userAgent: req.get("user-agent") }, "Download refused: too many in progress");
      res.set("Retry-After", "60");
      next(new H5pError("h5p-service:download-busy", {}, 503));
      return;
    }
    active += 1;
    let closed = false;
    res.once("close", () => {
      closed = true;
      active -= 1;
    });
    const clientGone = () => closed || res.destroyed;

    sendPackage(stack, contentId, (req as any).user, res, clientGone, idleTimeoutMs).catch((err) => {
      if (res.headersSent) res.destroy();
      else if (!clientGone()) next(err);
    });
  });

  router.use(errorHandler() as unknown as ErrorRequestHandler);
  return router;
}

interface PackageFile {
  path: string;
  open: () => Promise<Readable>;
}

async function sendPackage(
  stack: H5PStack,
  contentId: string,
  user: IUser,
  res: import("express").Response,
  clientGone: () => boolean,
  idleTimeoutMs: number
): Promise<void> {
  const storage = stack.contentStorage;
  const libraries = stack.editor.libraryManager;

  if (!(await storage.contentExists(contentId))) {
    throw new H5pError("download-content-not-found", { contentId }, 404);
  }
  if (!(await stack.permissionSystem.checkForContent(user, ContentPermission.Download, contentId))) {
    throw new H5pError("download-content-forbidden", { contentId }, 403);
  }

  const parameters = await storage.getParameters(contentId, user);
  let metadata: IContentMetadata;
  try {
    metadata = await storage.getMetadata(contentId, user);
  } catch {
    throw new H5pError("download-content-unreadable-metadata");
  }
  // Mutates `parameters`, which is why content.json is serialised after it.
  const substitutions = await shortenFilenames(stack, parameters, metadata);

  const files: PackageFile[] = [];
  for (const file of await storage.listFiles(contentId, user)) {
    files.push({
      path: `content/${substitutions[toUnix(file)] ?? file}`,
      open: () => storage.getFileStream(contentId, file, user),
    });
  }
  const dependencies = await new DependencyGetter(libraries.libraryStorage).getDependentLibraries(
    metadata.preloadedDependencies
      .concat(metadata.editorDependencies || [])
      .concat(metadata.dynamicDependencies || []),
    { editor: true, preloaded: true }
  );
  for (const library of dependencies) {
    for (const file of await libraries.listFiles(library)) {
      files.push({
        path: `${LibraryName.toUberName(library)}/${file}`,
        open: () => libraries.getFileStream(library, file),
      });
    }
  }
  if (clientGone()) return;

  const zip = new yazl.ZipFile();
  let current: Readable | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    current?.destroy();
    zip.outputStream.destroy();
  };
  const restartClock = () => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      log.info({ contentId, idleTimeoutMs }, "Closed a stalled download");
      stop();
      res.destroy();
    }, idleTimeoutMs);
  };

  // A file that fails to open or read after the headers went out leaves a
  // broken archive, so the connection is cut rather than ended cleanly.
  // Registered first: yazl starts opening files as soon as they are added.
  zip.on("error", (err) => {
    if (!stopped) log.warn({ err, contentId }, "Download failed");
    stop();
    res.destroy();
  });

  zip.addReadStream(Readable.from([JSON.stringify(parameters)]), "content/content.json");
  zip.addReadStream(Readable.from([JSON.stringify(metadata)]), "h5p.json");
  for (const file of files) {
    zip.addReadStreamLazy(file.path, (cb) => {
      if (stopped) return cb(new Error("download stopped"));
      file.open().then(
        (stream) => {
          if (stopped) {
            stream.destroy();
            return cb(new Error("download stopped"));
          }
          current = stream;
          stream.once("close", () => {
            if (current === stream) current = undefined;
          });
          cb(null, stream);
        },
        (err) => cb(err)
      );
    });
  }
  zip.end();

  res.writeHead(200, {
    "Content-Disposition": `attachment; filename=${contentId}.h5p`,
    "Content-Type": "application/zip",
  });
  restartClock();
  zip.outputStream.on("data", restartClock);
  res.on("drain", restartClock);
  pipeline(zip.outputStream, res, (err) => {
    res.off("drain", restartClock);
    stop();
    if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      log.warn({ err, contentId }, "Download stream failed");
    }
  });
}

/**
 * Lumi's `PackageExporter.shortenFilenames`: paths too long for the package
 * are renamed in the parameters, and the renames returned for the archive.
 */
async function shortenFilenames(
  stack: H5PStack,
  parameters: ContentParameters,
  metadata: IContentMetadata
): Promise<Record<string, string>> {
  const substitutions: Record<string, string> = {};
  const used: Record<string, boolean> = {};
  const scanner = new ContentFileScanner(stack.editor.libraryManager);
  const found = await scanner.scanForFiles(
    parameters,
    metadata.preloadedDependencies.find((dep) => dep.machineName === metadata.mainLibrary) as ILibraryName
  );
  for (const file of found) {
    if (file.filePath.length >= MAX_CONTENT_PATH_LENGTH) {
      const renamed = await generateFilename(
        file.filePath,
        // 9 for the short id and 8 for the "content/" prefix.
        (name) => utils.generalizedSanitizeFilename(name, new RegExp(""), MAX_CONTENT_PATH_LENGTH - 17),
        async (name) => used[name]
      );
      substitutions[file.filePath] = renamed;
      file.context.params.path = renamed;
      used[renamed] = true;
    } else {
      used[file.filePath] = true;
    }
  }
  return substitutions;
}

function toUnix(path: string): string {
  return path.replace(/\\/g, "/");
}
