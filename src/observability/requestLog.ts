import type { Request, RequestHandler } from "express";
import { childLogger } from "../logger.js";

const log = childLogger("http");

/**
 * Request groups worth telling apart when the S3 pools fill. `download` is
 * Lumi's .h5p export, which opens a stream for every file in the package;
 * `upload` is the editor's file upload, the first thing to fail when the
 * temporary bucket's pool is full.
 */
export type RequestKind = "download" | "upload" | "file" | "embed" | "ajax" | "other";

/** Always logged, whatever their outcome. */
const ALWAYS_LOGGED: ReadonlySet<RequestKind> = new Set(["download", "upload"]);

export function classify(req: Request): RequestKind {
  const path = req.path;
  if (path.startsWith("/h5p/download/")) return "download";
  if (path === "/h5p/ajax") return req.method === "POST" && req.query.action === "files" ? "upload" : "ajax";
  if (/^\/h5p\/(libraries|content|temp-files)\//.test(path)) return "file";
  if (/^\/h5p\/\d+\/embed$/.test(path)) return "embed";
  return "other";
}

export interface InFlightSummary {
  count: number;
  oldestMs: number;
}

/**
 * Requests whose response has not closed, by kind. A request that stays here
 * is one a client is still waiting on, which is how a hang shows up before
 * anyone leaves.
 */
export class InFlightRequests {
  private requests = new Set<{ kind: RequestKind; startedAt: number }>();

  add(kind: RequestKind): () => void {
    const entry = { kind, startedAt: Date.now() };
    this.requests.add(entry);
    return () => this.requests.delete(entry);
  }

  summary(): Partial<Record<RequestKind, InFlightSummary>> {
    const now = Date.now();
    const out: Partial<Record<RequestKind, InFlightSummary>> = {};
    for (const { kind, startedAt } of this.requests) {
      const s = (out[kind] ??= { count: 0, oldestMs: 0 });
      s.count += 1;
      s.oldestMs = Math.max(s.oldestMs, now - startedAt);
    }
    return out;
  }
}

/**
 * Logs downloads and uploads always, and any other request that fails, runs
 * longer than `slowMs`, or loses its client before the response finished.
 * Requests that succeed quickly, the bulk of embed traffic, are not logged.
 *
 * `cfRay` is Cloudflare's request id, so a line here can be matched to the
 * same request in Cloudflare's logs. `bytes` counts what reached the socket,
 * which for a streamed .h5p export is the only measure of how far it got.
 */
export function requestLog(inFlight: InFlightRequests, { slowMs }: { slowMs: number }): RequestHandler {
  return (req, res, next) => {
    const kind = classify(req);
    const startedAt = Date.now();
    const socket = req.socket;
    const bytesAtStart = socket.bytesWritten;
    const done = inFlight.add(kind);

    res.once("close", () => {
      done();
      const ms = Date.now() - startedAt;
      const aborted = !res.writableFinished;
      const failed = res.headersSent && res.statusCode >= 500;
      const slow = ms >= slowMs;
      if (!ALWAYS_LOGGED.has(kind) && !aborted && !failed && !slow) return;

      const fields = {
        kind,
        method: req.method,
        path: req.originalUrl,
        status: res.headersSent ? res.statusCode : undefined,
        ms,
        bytes: socket.bytesWritten - bytesAtStart,
        aborted,
        cfRay: req.get("cf-ray"),
        userAgent: req.get("user-agent"),
      };
      // An export the client left is the suspected socket leak, so it is a warning.
      if (failed || slow || (aborted && kind === "download")) log.warn(fields, aborted ? "Request aborted" : "Request finished");
      else log.info(fields, aborted ? "Request aborted" : "Request finished");
    });
    next();
  };
}
