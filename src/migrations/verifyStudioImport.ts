/**
 * Verifies a finished Studio import. READ-ONLY EVERYWHERE.
 *
 * The importer's own report says what it attempted. This checks what actually
 * landed, against the three places a migrated embed depends on:
 *
 *   Mongo   every Studio content id has a record, every Studio library is
 *           installed, and the id counter sits above every Studio id
 *           and each sampled activity carries Studio's display options
 *   S3      every library has its library.json and preloaded files, and every
 *           file a sampled activity's parameters reference exists under
 *           `{contentId}/` (which is what the phase A `aws s3 sync` produced)
 *   HTTP    optional: sampled `/h5p/{id}/embed` pages answer 200 without a
 *           redirect, and both Drupal-shaped resizer paths still 301
 *
 *   npx tsx --env-file=.env src/migrations/verifyStudioImport.ts \
 *     [--sample=200 | --sample=all] [--ids=101,102] [--base-url=https://staging.studio.libretexts.org]
 *
 * The sample takes one activity per main library first, so every content type
 * gets looked at, then fills out evenly across the id range. Studio rows the
 * importer skips on purpose (missing library, unparseable parameters) are
 * reported as expected rather than as failures. Exits non-zero when anything
 * unexplained turns up.
 *
 * Needs the same environment as the service plus the `STUDIO_MYSQL_*`
 * variables. No salt: nothing here reads identities.
 */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { S3, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import config from "../config.js";
import { loadStudioMysqlConfig } from "../config/env.js";
import { LEGACY_RESIZER_PATHS } from "../routes/legacy.js";
import logger, { childLogger } from "../logger.js";

const log = childLogger("studio-import-verify");

const DEFAULT_SAMPLE = 200;
const ID_BATCH = 10_000;
const CONCURRENCY = 16;
const HTTP_TIMEOUT_MS = 20_000;

/** Caps each list in the console summary. The JSON report keeps everything. */
const PRINT_LIMIT = 20;

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function parseSample(): number {
  const v = argValue("sample");
  if (v === undefined) return DEFAULT_SAMPLE;
  if (v === "all") return Infinity;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("--sample= takes a non-negative integer or 'all'.");
  }
  return n;
}

function parseIds(): number[] {
  const v = argValue("ids");
  if (!v) return [];
  return v.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--ids= has an invalid content id: "${s}".`);
    }
    return n;
  });
}

function parseBaseUrl(): string | undefined {
  const v = argValue("base-url");
  if (!v) return undefined;
  const url = new URL(v);
  return url.origin;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Local file paths an H5P parameter tree references. H5P stores media as
 * objects carrying a `path` relative to the content folder, with `#tmp`
 * appended while an upload is unsaved. URLs (YouTube, external images) live
 * in the same key and are not files.
 */
function referencedFiles(parameters: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "path" && typeof value === "string") {
          const p = value.replace(/#tmp$/, "");
          if (p && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("/") && !p.includes("..")) {
            found.add(p);
          }
        } else {
          walk(value);
        }
      }
    }
  };
  walk(parameters);
  return [...found];
}

/** Picks one id per main library, then fills evenly across the id range. */
function pickSample(byLibrary: Map<string, number[]>, all: number[], size: number): number[] {
  if (size >= all.length) return [...all];
  const picked = new Set<number>();
  for (const ids of byLibrary.values()) {
    if (picked.size >= size) break;
    picked.add(ids[Math.floor(ids.length / 2)]);
  }
  const remaining = size - picked.size;
  if (remaining > 0) {
    const step = all.length / remaining;
    for (let i = 0; i < remaining; i++) picked.add(all[Math.floor(i * step)]);
  }
  return [...picked].sort((a, b) => a - b);
}

export async function run(): Promise<void> {
  const mysqlConfig = loadStudioMysqlConfig();
  const sampleSize = parseSample();
  const explicitIds = parseIds();
  const baseUrl = parseBaseUrl();

  const report = {
    generatedAt: new Date().toISOString(),
    sampleSize: sampleSize === Infinity ? "all" : sampleSize,
    baseUrl: baseUrl ?? null,
    content: {
      studio: 0,
      mongo: 0,
      missing: [] as number[],
      expectedSkips: {
        missingLibrary: [] as number[],
        invalidParameters: [] as number[],
      },
      // At or below Studio's highest id but not in Studio. Above it is content
      // authored after the migration, which is not this script's business.
      unexpectedInMongo: [] as number[],
      mainLibraryMismatch: [] as { id: number; studio: string; mongo: string }[],
      // Sampled activities whose stored `disabledFeatures` differs from Studio's
      // `disabled_features`, or is missing (imported before the field existed).
      displayOptionsMismatch: [] as { id: number; studio: number; mongo: number | null }[],
      // --ids entries Studio never had. Not a problem, most likely a typo.
      requestedNotInStudio: [] as number[],
    },
    counter: { studioMaxId: 0, seq: null as number | null, ok: false },
    libraries: {
      studio: 0,
      mongo: 0,
      missingInMongo: [] as string[],
      missingFiles: [] as { ubername: string; file: string }[],
    },
    files: {
      checked: 0,
      referenced: 0,
      missing: [] as { id: number; file: string }[],
      contentWithNoFolder: [] as number[],
    },
    http: {
      checked: 0,
      failures: [] as { url: string; problem: string }[],
    },
    problems: 0,
  };

  const conn = await mysql.createConnection({
    ...mysqlConfig,
    connectTimeout: 20_000,
    enableKeepAlive: true,
  });
  const mongo = new MongoClient(config.mongo.url, {
    serverSelectionTimeoutMS: 30_000,
    socketTimeoutMS: 120_000,
  });
  const s3 = new S3({
    region: config.s3.region,
    ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
  });

  try {
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    await mongo.connect();
    const db = mongo.db(config.mongo.db);

    // ---------------------------------------------------------- libraries
    const [libRows] = await conn.query(
      `SELECT library_id, machine_name, major_version, minor_version FROM h5p_libraries`
    );
    const studioLibraries = new Map<number, { machine: string; uber: string }>();
    for (const l of libRows as any[]) {
      studioLibraries.set(l.library_id, {
        machine: l.machine_name,
        uber: `${l.machine_name}-${l.major_version}.${l.minor_version}`,
      });
    }
    report.libraries.studio = studioLibraries.size;

    const mongoLibraries = await db
      .collection(config.mongo.libraryCollection)
      .find({}, { projection: { ubername: 1, "metadata.preloadedJs": 1, "metadata.preloadedCss": 1 } })
      .toArray();
    report.libraries.mongo = mongoLibraries.length;
    const installed = new Set(mongoLibraries.map((l: any) => l.ubername as string));
    for (const { uber } of studioLibraries.values()) {
      if (!installed.has(uber)) report.libraries.missingInMongo.push(uber);
    }

    const libraryFiles: { ubername: string; file: string }[] = [];
    for (const l of mongoLibraries as any[]) {
      libraryFiles.push({ ubername: l.ubername, file: "library.json" });
      for (const f of [...(l.metadata?.preloadedJs ?? []), ...(l.metadata?.preloadedCss ?? [])]) {
        if (f?.path) libraryFiles.push({ ubername: l.ubername, file: f.path });
      }
    }
    await pool(libraryFiles, CONCURRENCY, async (lf) => {
      try {
        await s3.headObject({ Bucket: config.s3.libraryBucket, Key: `${lf.ubername}/${lf.file}` });
      } catch {
        report.libraries.missingFiles.push(lf);
      }
    });
    log.info(
      { libraries: mongoLibraries.length, files: libraryFiles.length },
      "Library files checked"
    );

    // -------------------------------------------------------- content ids
    // Ids only, in keyset batches, so no query holds a result open for long.
    const studioContent = new Map<number, number>(); // id -> library_id
    const studioDisabled = new Map<number, number>(); // id -> disabled_features
    const invalidParameters = new Set<number>();
    let lastId = 0;
    for (;;) {
      const [rows] = await conn.query(
        {
          sql: `SELECT id, library_id, disabled_features,
                       (parameters IS NULL OR NOT JSON_VALID(parameters)) AS bad
                FROM h5p_content WHERE id > ? ORDER BY id LIMIT ?`,
          timeout: 120_000,
        },
        [lastId, ID_BATCH]
      );
      const batch = rows as {
        id: number;
        library_id: number;
        disabled_features: number | null;
        bad: number | null;
      }[];
      if (!batch.length) break;
      for (const r of batch) {
        studioContent.set(r.id, r.library_id);
        studioDisabled.set(r.id, Number(r.disabled_features) || 0);
        if (r.bad) invalidParameters.add(r.id);
      }
      lastId = batch[batch.length - 1].id;
    }
    report.content.studio = studioContent.size;
    const studioMaxId = lastId;
    report.counter.studioMaxId = studioMaxId;

    const mongoContent = new Map<number, string>(); // id -> mainLibrary
    const cursor = db
      .collection(config.mongo.contentCollection)
      .find({}, { projection: { "metadata.mainLibrary": 1 } });
    for await (const doc of cursor) {
      mongoContent.set(Number(doc._id), (doc as any).metadata?.mainLibrary ?? "");
    }
    report.content.mongo = mongoContent.size;

    for (const [id, libraryId] of studioContent) {
      if (mongoContent.has(id)) continue;
      if (!studioLibraries.has(libraryId)) report.content.expectedSkips.missingLibrary.push(id);
      else if (invalidParameters.has(id)) report.content.expectedSkips.invalidParameters.push(id);
      else report.content.missing.push(id);
    }
    for (const id of mongoContent.keys()) {
      if (id <= studioMaxId && !studioContent.has(id)) report.content.unexpectedInMongo.push(id);
    }

    const counter = await db
      .collection<{ _id: string; seq: number }>(config.mongo.counterCollection)
      .findOne({ _id: "contentId" });
    report.counter.seq = counter?.seq ?? null;
    report.counter.ok = (counter?.seq ?? -1) >= studioMaxId;

    // ------------------------------------------------------ sampled files
    const inBoth = [...mongoContent.keys()].filter((id) => studioContent.has(id)).sort((a, b) => a - b);
    const byLibrary = new Map<string, number[]>();
    for (const id of inBoth) {
      const lib = mongoContent.get(id)!;
      const list = byLibrary.get(lib) ?? [];
      list.push(id);
      byLibrary.set(lib, list);
    }
    for (const id of explicitIds) {
      if (!studioContent.has(id)) report.content.requestedNotInStudio.push(id);
    }
    const sample = [
      ...new Set([
        ...explicitIds.filter((id) => studioContent.has(id)),
        ...pickSample(byLibrary, inBoth, sampleSize),
      ]),
    ];
    log.info({ sample: sample.length, libraries: byLibrary.size }, "Checking sampled content");

    const contentCollection = db.collection(config.mongo.contentCollection);
    await pool(sample, CONCURRENCY, async (id) => {
      const doc: any = await contentCollection.findOne(
        { _id: String(id) as any },
        { projection: { parameters: 1, "metadata.mainLibrary": 1, disabledFeatures: 1 } }
      );
      // Only reachable through --ids naming a Studio id that was not imported,
      // which the id comparison above has already reported.
      if (!doc) return;
      report.files.checked += 1;

      const studioLib = studioLibraries.get(studioContent.get(id) ?? -1)?.machine;
      if (studioLib && doc.metadata?.mainLibrary !== studioLib) {
        report.content.mainLibraryMismatch.push({
          id,
          studio: studioLib,
          mongo: doc.metadata?.mainLibrary ?? "",
        });
      }

      const studioBits = studioDisabled.get(id) ?? 0;
      const mongoBits = typeof doc.disabledFeatures === "number" ? doc.disabledFeatures : null;
      if (mongoBits !== studioBits) {
        report.content.displayOptionsMismatch.push({ id, studio: studioBits, mongo: mongoBits });
      }

      const wanted = referencedFiles(doc.parameters);
      report.files.referenced += wanted.length;
      if (!wanted.length) return;

      const present = new Set<string>();
      let token: string | undefined;
      do {
        const page: ListObjectsV2CommandOutput = await s3.listObjectsV2({
          Bucket: config.s3.contentBucket,
          Prefix: `${id}/`,
          ContinuationToken: token,
        });
        for (const o of page.Contents ?? []) present.add(o.Key!.slice(`${id}/`.length));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);

      if (!present.size) report.files.contentWithNoFolder.push(id);
      for (const f of wanted) {
        if (!present.has(f)) report.files.missing.push({ id, file: f });
      }
    });

    // --------------------------------------------------------------- http
    if (baseUrl) {
      const check = async (url: string, expect: (r: Response, body: string) => string | null) => {
        report.http.checked += 1;
        try {
          const res = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
          const body = res.status === 200 ? await res.text() : "";
          const problem = expect(res, body);
          if (problem) report.http.failures.push({ url, problem });
        } catch (err: any) {
          report.http.failures.push({ url, problem: err?.message ?? String(err) });
        }
      };

      // A redirect here is a failure even if it lands on a working page: it
      // changes the iframe's origin, which the resizer handshake and ADAPT's
      // grading relay are checked against.
      await pool(sample, 4, (id) =>
        check(`${baseUrl}/h5p/${id}/embed`, (res, body) => {
          if (res.status !== 200) return `status ${res.status}${res.headers.get("location") ? ` -> ${res.headers.get("location")}` : ""}`;
          if (!body.includes("__LIBRETEXTS_EMBED__")) return "200 but not an h5p-service embed page";
          return null;
        })
      );

      for (const legacy of LEGACY_RESIZER_PATHS) {
        await check(`${baseUrl}${legacy}`, (res) => {
          const location = res.headers.get("location") ?? "";
          if (res.status !== 301) return `status ${res.status}, expected 301`;
          if (!location.endsWith("/h5p/core/js/h5p-resizer.js")) return `301 to ${location}`;
          return null;
        });
      }
      await check(`${baseUrl}/h5p/core/js/h5p-resizer.js`, (res) =>
        res.status === 200 ? null : `status ${res.status}`
      );
    }
  } finally {
    await conn.end();
    await mongo.close();
    s3.destroy();
  }

  // Workers finish in any order; sort so two runs over the same state diff cleanly.
  report.libraries.missingFiles.sort((a, b) =>
    `${a.ubername}/${a.file}`.localeCompare(`${b.ubername}/${b.file}`)
  );
  report.files.missing.sort((a, b) => a.id - b.id || a.file.localeCompare(b.file));
  report.files.contentWithNoFolder.sort((a, b) => a - b);
  report.content.mainLibraryMismatch.sort((a, b) => a.id - b.id);
  report.content.displayOptionsMismatch.sort((a, b) => a.id - b.id);
  report.http.failures.sort((a, b) => a.url.localeCompare(b.url));

  report.problems =
    report.content.missing.length +
    report.content.unexpectedInMongo.length +
    report.content.mainLibraryMismatch.length +
    report.content.displayOptionsMismatch.length +
    (report.counter.ok ? 0 : 1) +
    report.libraries.missingInMongo.length +
    report.libraries.missingFiles.length +
    report.files.missing.length +
    report.http.failures.length;

  const outDir = path.resolve("migration-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outDir, `h5p-import-verify-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const list = (items: unknown[]) =>
    items.length
      ? `\n      ${items.slice(0, PRINT_LIMIT).map((i) => JSON.stringify(i)).join("\n      ")}` +
        (items.length > PRINT_LIMIT ? `\n      ... ${items.length - PRINT_LIMIT} more in the report` : "")
      : "";
  const c = report.content;
  process.stdout.write(
    `\nVERIFY  ${report.problems ? `${report.problems} PROBLEM(S)` : "OK"}\n` +
      `  Content in Studio / Mongo:      ${c.studio} / ${c.mongo}\n` +
      `    missing from Mongo:           ${c.missing.length}${list(c.missing)}\n` +
      `    expected skips:               ${c.expectedSkips.missingLibrary.length} missing library, ${c.expectedSkips.invalidParameters.length} invalid parameters\n` +
      `    in Mongo but not Studio:      ${c.unexpectedInMongo.length}${list(c.unexpectedInMongo)}\n` +
      `    main library mismatch:        ${c.mainLibraryMismatch.length}${list(c.mainLibraryMismatch)}\n` +
      `    display options mismatch:     ${c.displayOptionsMismatch.length}${list(c.displayOptionsMismatch)}
` +
      (c.requestedNotInStudio.length
        ? `    --ids not in Studio:          ${c.requestedNotInStudio.length}${list(c.requestedNotInStudio)}\n`
        : "") +
      `  Id counter:                     ${report.counter.seq ?? "missing"} (Studio max ${report.counter.studioMaxId})${report.counter.ok ? "" : "  TOO LOW"}\n` +
      `  Libraries in Studio / Mongo:    ${report.libraries.studio} / ${report.libraries.mongo}\n` +
      `    missing from Mongo:           ${report.libraries.missingInMongo.length}${list(report.libraries.missingInMongo)}\n` +
      `    files missing from S3:        ${report.libraries.missingFiles.length}${list(report.libraries.missingFiles)}\n` +
      `  Sampled content checked:        ${report.files.checked}\n` +
      `    files referenced / missing:   ${report.files.referenced} / ${report.files.missing.length}${list(report.files.missing)}\n` +
      (baseUrl
        ? `  HTTP checks against ${baseUrl}:  ${report.http.checked}, ${report.http.failures.length} failed${list(report.http.failures)}\n`
        : `  HTTP checks:                    skipped (pass --base-url= to run them)\n`) +
      `\nReport: ${reportPath}\n`
  );
  if (report.problems) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].includes("verifyStudioImport")) {
  // No process.exit(): fetch's keep-alive sockets are still closing when `run`
  // resolves, and exiting under them trips a libuv assertion on Windows. Every
  // other handle is closed in `run`, so the process ends on its own.
  run().catch((err) => {
    logger.error({ err }, "Studio import verification failed");
    process.exitCode = 1;
  });
}
