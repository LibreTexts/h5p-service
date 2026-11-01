import { pipeline, type Readable } from "node:stream";
import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { lookup } from "mime-types";
import { errorHandler } from "@lumieducation/h5p-express/build/expressErrorHandler.js";
import { H5PAjaxEndpoint, H5pError, LibraryName } from "@lumieducation/h5p-server";
import type { H5PStack } from "../h5p.js";
import { childLogger } from "../logger.js";

const log = childLogger("files");

/** Serves a request. `clientGone` turns true once the response has closed. */
type FileHandler = (req: Request, res: Response, clientGone: () => boolean) => Promise<void>;

/**
 * Library, content and temporary file routes, in place of the ones in
 * `h5pAjaxExpressRouter`. Derived from Lumi's `H5PAjaxExpressController`
 * (GPL-3.0-or-later). URLs, headers and error bodies match it, because every
 * published embed loads its files through these paths.
 *
 * Each S3 response body holds one socket from the client's pool until it is
 * read to the end or destroyed, and upstream can leave one unattended forever:
 *
 * - It listens for the response closing only after the storage calls return.
 *   A client that left during that wait fires `close` before anyone listens,
 *   and the stream is piped into a dead response, which never drains.
 * - `getLibraryFile` opens the stream alongside the stats call, so a stats
 *   failure drops a stream nobody reads.
 * - A client that stays connected and stops reading, as a buffered `<video>`
 *   does, holds its socket through backpressure for as long as the tab is open.
 *
 * Fifty of these fill the pool, after which every S3 call in the service
 * queues behind them until a restart. So the close listener goes on before the
 * first await, stats run before the stream opens, and a stream that makes no
 * progress for `idleTimeoutMs` is destroyed. A media element that wants more
 * asks again with a Range request.
 *
 * Errors do not reach the handler at the end of Lumi's router, because Express
 * skips a non-error router when passing an error on, so this one mounts its own.
 */
export default function fileRouter(
  stack: H5PStack,
  { idleTimeoutMs, temporaryFiles }: { idleTimeoutMs: number; temporaryFiles: boolean }
): Router {
  const router = Router();
  const endpoint = new H5PAjaxEndpoint(stack.editor);

  router.get(
    `${stack.config.librariesUrl}/:uberName/:file(*)`,
    serve(async (req, res, clientGone) => {
      const library = LibraryName.fromUberName(req.params.uberName);
      const file = req.params.file;
      const stats = await stack.editor.libraryManager.getFileStats(library, file);
      if (clientGone()) return;
      const stream = await stack.editor.getLibraryFileStream(library, file);
      sendStream(req, res, stream, clientGone, idleTimeoutMs, 200, {
        "Cache-Control": "public, max-age=31536000",
        "Content-Type": lookup(file) || "application/octet-stream",
        "Content-Length": stats.size,
        "Accept-Ranges": "bytes",
      });
    })
  );

  router.get(
    `${stack.config.contentFilesUrl}/:id/:file(*)`,
    serve(async (req, res, clientGone) => {
      const file = await endpoint.getContentFile(req.params.id, req.params.file, (req as any).user, parseRange(req));
      sendFile(req, res, file, clientGone, idleTimeoutMs);
    })
  );

  if (temporaryFiles) {
    router.get(
      `${stack.config.temporaryFilesUrl}/:file(*)`,
      serve(async (req, res, clientGone) => {
        // Lumi types the callback as always returning a range, then handles none.
        const range = parseRange(req) as (fileSize: number) => { start: number; end: number };
        const file = await endpoint.getTemporaryFile(req.params.file, (req as any).user, range);
        sendFile(req, res, file, clientGone, idleTimeoutMs);
      })
    );
  }

  router.use(errorHandler() as unknown as ErrorRequestHandler);
  return router;
}

/**
 * Watches for the response closing from the moment the request arrives.
 * `destroyed` turns true before `close` fires, so `clientGone` checks both.
 *
 * Errors after the headers go out never reach Lumi's handler. It would throw
 * setting a status, and being async, that is an unhandled rejection, which
 * stops the process.
 */
function serve(handler: FileHandler): RequestHandler {
  return (req, res, next) => {
    let closed = false;
    res.once("close", () => {
      closed = true;
    });
    const clientGone = () => closed || res.destroyed;
    handler(req, res, clientGone).catch((err) => {
      if (res.headersSent) res.destroy();
      else if (!clientGone()) next(err);
    });
  };
}

/** The Range header as Lumi's endpoint wants it, once it knows the file size. */
function parseRange(req: Request) {
  return (fileSize: number) => {
    const range = req.range(fileSize);
    if (!range) return undefined;
    if (range === -2) throw new H5pError("malformed-request", {}, 400);
    if (range === -1) throw new H5pError("unsatisfiable-range", {}, 416);
    if (range.length > 1) throw new H5pError("multipart-ranges-unsupported", {}, 400);
    return range[0];
  };
}

function sendFile(
  req: Request,
  res: Response,
  file: { mimetype: string; stream: Readable; stats: { size: number }; range?: { start: number; end: number } },
  clientGone: () => boolean,
  idleTimeoutMs: number
): void {
  const { mimetype, stream, stats, range } = file;
  if (range) {
    sendStream(req, res, stream, clientGone, idleTimeoutMs, 206, {
      "Content-Type": mimetype,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
    });
    return;
  }
  sendStream(req, res, stream, clientGone, idleTimeoutMs, 200, {
    "Content-Type": mimetype,
    "Content-Length": stats.size,
    "Accept-Ranges": "bytes",
  });
}

/**
 * Pipes a storage stream to the response and guarantees the stream is released.
 *
 * Progress means a chunk arriving from storage or the response draining, so a
 * slow reader keeps its download. The clock stops when storage has delivered
 * the last byte, because the socket is back in the pool by then.
 */
function sendStream(
  req: Request,
  res: Response,
  stream: Readable,
  clientGone: () => boolean,
  idleTimeoutMs: number,
  status: number,
  headers: Record<string, string | number>
): void {
  if (clientGone()) {
    stream.destroy();
    return;
  }

  let stalled = false;
  let timer: NodeJS.Timeout;
  const stopClock = () => clearTimeout(timer);
  const restartClock = () => {
    stopClock();
    timer = setTimeout(() => {
      stalled = true;
      log.info({ path: req.path, idleTimeoutMs }, "Closed a stalled file stream");
      stream.destroy();
      res.destroy();
    }, idleTimeoutMs);
  };

  try {
    res.writeHead(status, headers);
    restartClock();
    stream.on("data", restartClock);
    stream.once("end", stopClock);
    res.on("drain", restartClock);

    // `pipeline` throws synchronously if the response is already destroyed.
    pipeline(stream, res, (err) => {
      stopClock();
      res.off("drain", restartClock);
      // A premature close is a client leaving, which is ordinary.
      if (err && !stalled && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
        log.warn({ err, path: req.path }, "File stream failed");
      }
    });
  } catch (err) {
    stopClock();
    stream.destroy();
    throw err;
  }
}
