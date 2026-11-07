/**
 * Exercises the file routes that published embeds load through, which need no
 * database: the real router, S3 client and storage classes against a fake S3
 * on localhost.
 *
 * The point of it is the S3 socket pool. A file download holds a socket until
 * it is read or destroyed, and fifty held sockets stop every S3 call in the
 * service until a restart. Each scenario here pins that pool the way real
 * clients do, then checks a healthy request still gets through.
 */
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import express from "express";
import { S3 } from "@aws-sdk/client-s3";
import { H5pError, streamToString } from "@lumieducation/h5p-server";

// Each stalled stream logs a line, which is noise here.
process.env.LOG_LEVEL ||= "warn";

const { default: fileRouter } = await import("../dist/routes/files.js");
const { default: StreamingLibraryStorage } = await import("../dist/storage/StreamingLibraryStorage.js");
const { default: IntegerIdContentStorage } = await import("../dist/storage/IntegerIdContentStorage.js");
const { default: TemporaryFileStorage } = await import("../dist/storage/TemporaryFileStorage.js");
const { default: downloadRouter } = await import("../dist/routes/download.js");
const { S3Pool } = await import("../dist/observability/s3Pool.js");
const { PoolMonitor } = await import("../dist/observability/poolGauge.js");
const { InFlightRequests } = await import("../dist/observability/requestLog.js");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IDLE_TIMEOUT_MS = 800;
const CLIENTS = 60; // more than the 50 sockets in the SDK's default pool
const LARGE = 16 * 1024 * 1024; // too large to sit unread in kernel buffers

// ------------------------------------------------------------ fake S3
const fakeS3s = [];
async function startFakeS3(size) {
  const body = Buffer.alloc(size, "x");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    const part = range ? body.subarray(Number(range[1]), Number(range[2]) + 1) : body;
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": part.length,
    });
    res.end(req.method === "HEAD" ? undefined : part);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fakeS3s.push(server);
  const s3 = new S3({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "verify", secretAccessKey: "verify" },
  });
  return { s3, seen };
}

// ------------------------------------------------------------ stack
function stackFor(s3, size, { storageDelayMs = 0 } = {}) {
  const missing = (filename) => new H5pError("content-file-missing", { filename }, 404);
  const open = async (Key, Range) => (await s3.getObject({ Bucket: "verify", Key, Range })).Body;
  const editor = {
    libraryManager: {
      getFileStats: async (_library, file) => {
        await sleep(storageDelayMs);
        if (file === "missing.js") throw missing(file);
        return { size };
      },
    },
    getLibraryFileStream: (_library, file) => open(`lib/${file}`),
    contentManager: {
      getContentFileStats: async (_id, file) => {
        if (file === "missing.mp4") throw missing(file);
        return { size };
      },
    },
    getContentFileStream: (id, file, _user, start, end) =>
      open(`${id}/${file}`, start === undefined ? undefined : `bytes=${start}-${end}`),
    temporaryFileManager: { getFileStats: async () => ({ size }) },
    getTemporaryFileStream: () => open("temp"),
  };
  return {
    editor,
    config: { librariesUrl: "/libraries", contentFilesUrl: "/content", temporaryFilesUrl: "/temp-files" },
  };
}

const servers = [];
async function startApp(stack, { temporaryFiles = true } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: "verify" };
    next();
  });
  app.use("/h5p", fileRouter(stack, { idleTimeoutMs: IDLE_TIMEOUT_MS, temporaryFiles }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return server.address().port;
}

function get(port, path, { headers, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ port, host: "127.0.0.1", path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    });
    req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, hung: true, headers: {}, body: Buffer.alloc(0) });
    });
  });
}

const REQUEST = "GET /h5p/libraries/H5P.Verify-1.0/large.js HTTP/1.1\r\nHost: verify\r\nConnection: close\r\n\r\n";
const sockets = [];

/** Sends a request and leaves while storage is still answering. */
function leaveEarly(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(REQUEST));
    socket.on("error", () => {});
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 40);
  });
}

/** Sends a request, stays connected and stops reading, like a buffered video. */
function stopReading(port) {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(REQUEST);
    socket.pause();
  });
  socket.on("error", () => {});
  sockets.push(socket);
}

// ------------------------------------------------------------ responses
{
  const size = 4096;
  const { s3, seen } = await startFakeS3(size);
  const port = await startApp(stackFor(s3, size));
  const base = "/h5p/libraries/H5P.Verify-1.0";

  let r = await get(port, `${base}/scripts/a.js`);
  check("a library file is served whole", r.status === 200 && r.body.length === size);
  check("a library file stays cacheable for a year", r.headers["cache-control"] === "public, max-age=31536000");
  check("a library file carries its type", /javascript/.test(r.headers["content-type"] ?? ""), r.headers["content-type"]);
  check("a library file carries its length", r.headers["content-length"] === String(size));

  seen.length = 0;
  r = await get(port, `${base}/missing.js`);
  check("a missing library file is a 404 from the H5P error handler", r.status === 404 && /content-file-missing/.test(r.body.toString()));
  check("a missing library file opens no S3 stream", seen.length === 0, seen.join(", "));

  r = await get(port, "/h5p/libraries/not-an-ubername/a.js");
  check("a malformed library name is an error, not a hang", r.status >= 400, String(r.status));

  r = await get(port, "/h5p/content/31483/videos/a.mp4");
  check("a content file is served whole", r.status === 200 && r.body.length === size);
  check("a content file advertises ranges", r.headers["accept-ranges"] === "bytes");
  check("a content file carries its type", r.headers["content-type"] === "video/mp4", r.headers["content-type"]);

  r = await get(port, "/h5p/content/31483/videos/a.mp4", { headers: { Range: "bytes=10-19" } });
  check("a range request is a 206", r.status === 206 && r.body.length === 10);
  check("a range response says which bytes", r.headers["content-range"] === `bytes 10-19/${size}`);
  check("a range response carries the media type", r.headers["content-type"] === "video/mp4", r.headers["content-type"]);

  r = await get(port, "/h5p/content/31483/videos/a.mp4", { headers: { Range: `bytes=${size + 1}-` } });
  check("an unsatisfiable range is a 416", r.status === 416, String(r.status));

  r = await get(port, "/h5p/content/31483/missing.mp4");
  check("a missing content file is a 404", r.status === 404);

  r = await get(port, "/h5p/temp-files/a.png");
  check("a temporary file is served when authoring is on", r.status === 200);

  const closed = await startApp(stackFor(s3, size), { temporaryFiles: false });
  r = await get(closed, "/h5p/temp-files/a.png");
  check("temporary files are not routed when authoring is off", r.status === 404);
}

// ------------------------------------------------------------ the pool
{
  const { s3 } = await startFakeS3(LARGE);
  const port = await startApp(stackFor(s3, LARGE, { storageDelayMs: 150 }));
  await Promise.all(Array.from({ length: CLIENTS }, () => leaveEarly(port)));
  await sleep(1000);
  const r = await get(port, "/h5p/libraries/H5P.Verify-1.0/large.js");
  check(`${CLIENTS} clients leaving mid-request do not pin the pool`, r.status === 200 && r.body.length === LARGE, r.hung ? "hung" : "");
}

{
  const { s3 } = await startFakeS3(LARGE);
  const port = await startApp(stackFor(s3, LARGE));
  for (let i = 0; i < CLIENTS; i++) stopReading(port);
  await sleep(IDLE_TIMEOUT_MS * 3);
  const r = await get(port, "/h5p/libraries/H5P.Verify-1.0/large.js");
  check(`${CLIENTS} clients that stop reading release the pool`, r.status === 200 && r.body.length === LARGE, r.hung ? "hung" : "");
}

// A response is destroyed before its `close` event fires. In that window
// `pipeline` throws, and an error reaching Lumi's async handler once headers
// have gone out is an unhandled rejection, which would stop the process.
{
  const opened = new Readable({ read() {} });
  let response;
  const stack = stackFor(null, 4096);
  stack.editor.getLibraryFileStream = async () => {
    response.destroy();
    return opened;
  };
  const app = express();
  app.use((_req, res, next) => {
    response = res;
    next();
  });
  app.use("/h5p", fileRouter(stack, { idleTimeoutMs: IDLE_TIMEOUT_MS, temporaryFiles: false }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);

  await get(server.address().port, "/h5p/libraries/H5P.Verify-1.0/a.js");
  await sleep(50);
  check("a response destroyed before its close event still releases the stream", opened.destroyed);
}

// ------------------------------------------------------------ the two clients
{
  const quick = await startFakeS3(64);
  const stream = await startFakeS3(64);
  const collection = {
    findOne: async () => ({ metadata: { title: "verify" } }),
  };
  const library = { machineName: "H5P.Verify", majorVersion: 1, minorVersion: 0 };
  const storage = new StreamingLibraryStorage(quick.s3, collection, { s3Bucket: "verify" }, stream.s3);

  await streamToString(await storage.getFileStream(library, "scripts/a.js"));
  check("a library download opens on the stream client", stream.seen.length === 1 && quick.seen.length === 0);

  stream.seen.length = 0;
  await storage.getFileAsString(library, "semantics.json");
  check("a library JSON read stays on the quick client", quick.seen.length === 1 && stream.seen.length === 0);

  quick.seen.length = 0;
  const metadata = await streamToString(await storage.getFileStream(library, "library.json"));
  check("library.json still comes from MongoDB", /verify/.test(metadata) && quick.seen.length === 0 && stream.seen.length === 0);

  const content = new IntegerIdContentStorage(quick.s3, {}, {}, { s3Bucket: "verify", streamS3: stream.s3 });
  await content.getFileStats("31483", "a.mp4");
  check("a content HEAD stays on the quick client", quick.seen.length === 1 && stream.seen.length === 0);
  await streamToString(await content.getFileStream("31483", "a.mp4"));
  check("a content download opens on the stream client", stream.seen.length === 1);
}

// ------------------------------------------------------------ the .h5p download
// Lumi's exporter opened a stream for every file in the package at once and
// left them all held when the client went. GoogleOther fetches these links.

/**
 * A fake S3 that counts responses still being sent, and the most at once.
 * Random bytes, because yazl deflates: repeated bytes would shrink to almost
 * nothing and a client that stops reading would never push back.
 */
async function startCountingS3(size, { pool } = {}) {
  const body = randomBytes(size);
  const state = { open: 0, maxOpen: 0, gets: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET") state.gets += 1;
    state.open += 1;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    res.once("close", () => (state.open -= 1));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fakeS3s.push(server);
  const s3 = new S3({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "verify", secretAccessKey: "verify" },
    ...(pool ? { requestHandler: pool.requestHandler() } : {}),
  });
  return { s3, state };
}

const inUse = (pool) => pool.stats().origins.shared?.inUse ?? 0;

const LIBRARY_FILES = 120; // more than twice the pool, like an Interactive Book
const CONTENT_FILES = ["images/a.png", "images/b.png"];

function downloadStack(s3) {
  const open = async (Key) => (await s3.getObject({ Bucket: "verify", Key })).Body;
  const library = { machineName: "H5P.Verify", majorVersion: 1, minorVersion: 0 };
  const metadata = { title: "verify", mainLibrary: "H5P.Verify", preloadedDependencies: [library] };
  return {
    config: { downloadUrl: "/download" },
    permissionSystem: { checkForContent: async () => true },
    contentStorage: {
      contentExists: async (id) => id === "31483",
      getParameters: async () => ({ text: "verify" }),
      getMetadata: async () => metadata,
      listFiles: async () => CONTENT_FILES,
      getFileStream: (id, file) => open(`${id}/${file}`),
    },
    editor: {
      libraryManager: {
        libraryStorage: { getLibrary: async (name) => ({ ...name, preloadedDependencies: [] }) },
        getSemantics: async () => [],
        listFiles: async () => Array.from({ length: LIBRARY_FILES }, (_, i) => `scripts/f${i}.js`),
        getFileStream: (_library, file) => open(`lib/${file}`),
      },
    },
  };
}

async function startDownloadApp(stack, { maxConcurrent = 100, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: "verify" };
    next();
  });
  app.use("/h5p", downloadRouter(stack, { idleTimeoutMs, maxConcurrent }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return server.address().port;
}

const DOWNLOAD = "GET /h5p/download/31483 HTTP/1.1\r\nHost: verify\r\nConnection: close\r\n\r\n";

/** Starts a download and stops reading it, like a client that stalled. */
function stallDownload(port) {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write(DOWNLOAD);
    socket.pause();
  });
  socket.on("error", () => {});
  sockets.push(socket);
}

{
  const pool = new S3Pool("verify");
  const { s3, state } = await startCountingS3(64 * 1024, { pool });
  const port = await startDownloadApp(downloadStack(s3));

  const r = await get(port, "/h5p/download/31483", { timeoutMs: 20000 });
  const text = r.body.toString("latin1");
  check("a download is a 200 zip", r.status === 200 && r.headers["content-type"] === "application/zip" && text.startsWith("PK"));
  check("a download names the package after the content id", r.headers["content-disposition"] === "attachment; filename=31483.h5p");
  const names = ["h5p.json", "content/content.json", ...CONTENT_FILES.map((f) => `content/${f}`), "H5P.Verify-1.0/scripts/f119.js"];
  check("a download carries metadata, parameters, content files and library files", names.every((n) => text.includes(n)));
  check("a download opens one S3 file at a time", state.maxOpen === 1, `max open ${state.maxOpen}`);

  const missing = await get(port, "/h5p/download/999");
  check("a download of unknown content is a 404", missing.status === 404, String(missing.status));

  // Clients that leave partway, as a crawler that gives up does.
  await Promise.all(
    Array.from({ length: CLIENTS }, () =>
      new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(DOWNLOAD));
        socket.on("error", () => {});
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 60);
      })
    )
  );
  await sleep(500);
  const gets = state.gets;
  await sleep(500);
  check(`${CLIENTS} downloads the client left stop opening files`, state.gets === gets, `${state.gets - gets} more GETs`);
  check(`${CLIENTS} downloads the client left hold no S3 sockets`, inUse(pool) === 0, JSON.stringify(pool.stats().origins));
}

{
  const pool = new S3Pool("verify");
  const { s3 } = await startCountingS3(4 * 1024 * 1024, { pool });
  const port = await startDownloadApp(downloadStack(s3));
  for (let i = 0; i < 5; i++) stallDownload(port);
  await sleep(IDLE_TIMEOUT_MS * 3);
  check("downloads whose client stopped reading release their sockets", inUse(pool) === 0, JSON.stringify(pool.stats().origins));
}

{
  const { s3 } = await startCountingS3(LARGE);
  const port = await startDownloadApp(downloadStack(s3), { maxConcurrent: 2, idleTimeoutMs: 5000 });
  stallDownload(port);
  stallDownload(port);
  await sleep(300);
  const r = await get(port, "/h5p/download/31483");
  check("a download beyond the limit is a 503 with Retry-After", r.status === 503 && r.headers["retry-after"] === "60", String(r.status));
}

// ------------------------------------------------------------ request timeouts
// A request queued behind a full pool used to wait forever.
{
  const held = [];
  const server = http.createServer((_req, res) => held.push(res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fakeS3s.push(server);
  const silentS3 = (pool, extra = {}) =>
    new S3({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${server.address().port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "verify", secretAccessKey: "verify" },
      requestHandler: pool.requestHandler(),
      ...extra,
    });

  const pool = new S3Pool("verify", {}, 1000);
  const s3 = silentS3(pool, { maxAttempts: 1 });
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: CLIENTS }, (_, i) => s3.headObject({ Bucket: "verify", Key: `k${i}` })));
  const ms = Date.now() - started;
  check(`${CLIENTS} requests to an S3 that never answers all fail`, results.every((r) => r.status === "rejected"));
  check("queued requests fail within their timeout rather than waiting their turn", ms < 3000, `${ms} ms`);
  await sleep(100);
  const stats = pool.stats().origins.shared ?? { inUse: 0, queued: 0 };
  check("timed-out requests leave nothing queued or held", stats.inUse === 0 && stats.queued === 0, JSON.stringify(stats));

  // The monitor calls a pool stuck once it has queued at every sample past the limit.
  const stuckPool = new S3Pool("stuck");
  const stuckS3 = silentS3(stuckPool);
  for (let i = 0; i < CLIENTS; i++) stuckS3.headObject({ Bucket: "verify", Key: `s${i}` }).catch(() => {});
  await sleep(300);
  const monitor = new PoolMonitor([stuckPool], new InFlightRequests(), { reportMs: 60_000, unhealthyAfterMs: 200 });
  monitor.sample();
  check("a pool queued for less than the limit is not stuck", Object.keys(monitor.stuck()).length === 0);
  await sleep(300);
  monitor.sample();
  check("a pool queued past the limit is stuck", Object.keys(monitor.stuck()).join() === "stuck shared", JSON.stringify(monitor.stuck()));
  for (const res of held) res.destroy();
  stuckPool.httpAgent.destroy();
}

// ------------------------------------------------------------ temporary files
// Lumi's save copies uploads into the activity and cleans up with close(),
// which an S3 body lacks, so a failed copy held its socket for good.
{
  const pool = new S3Pool("verify");
  const { s3 } = await startCountingS3(LARGE, { pool });
  const storage = new TemporaryFileStorage(s3, { s3Bucket: "verify" });
  const stream = await storage.getFileStream("images/a.png", { id: "verify" });
  check("a temporary file stream can be closed", typeof stream.close === "function");
  stream.close();
  await sleep(100);
  check("closing a temporary file stream releases its socket", inUse(pool) === 0, JSON.stringify(pool.stats().origins));

  const { s3: ranged } = await startFakeS3(4096);
  const tmp = new TemporaryFileStorage(ranged, { s3Bucket: "verify" });
  const first = await streamToString(await tmp.getFileStream("images/a.png", { id: "verify" }, 0, 9));
  check("a temporary file range starting at byte 0 is a range", first.length === 10, `${first.length} bytes`);
}

// ------------------------------------------------------------ done
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exitCode = failures ? 1 : 0;
for (const socket of sockets) socket.destroy();
for (const server of [...servers, ...fakeS3s]) {
  server.closeAllConnections();
  server.close();
}
