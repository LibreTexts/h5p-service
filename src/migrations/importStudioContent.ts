/**
 * Studio -> h5p-service content and library import. DRY RUN BY DEFAULT.
 *
 * Phase B of the migration. Reads Studio's MySQL read-only and writes the H5P
 * library and content RECORDS into this service's Mongo, preserving Studio's
 * integer content ids so published embeds keep resolving.
 *
 * It does NOT copy files. Content files and library files move in phase A with
 * a plain `aws s3 sync`, which works because both storage layers key S3
 * objects the same way Studio lays them out on disk:
 *
 *   libraries   {MachineName}-{major}.{minor}/...   <- files/h5p/libraries/
 *   content     {contentId}/...                     <- files/h5p/content/
 *
 * So the full sequence is:
 *
 *   aws s3 sync web/sites/default/files/h5p/libraries s3://$S3_LIBRARY_BUCKET
 *   aws s3 sync web/sites/default/files/h5p/content   s3://$S3_CONTENT_BUCKET
 *   npx tsx src/migrations/importStudioContent.ts --commit
 *
 * Libraries are written before content because content records reference them
 * and the player resolves dependencies through library storage.
 *
 *   STUDIO_MYSQL_HOST=... STUDIO_MYSQL_USER=... STUDIO_MYSQL_PASSWORD=... \
 *   STUDIO_MYSQL_DATABASE=studio_main \
 *   npx tsx --env-file=.env src/migrations/importStudioContent.ts [--commit]
 *
 * Idempotent: libraries and content are upserted by their natural key, so a
 * re-run after a partial failure is safe and resumes rather than duplicating.
 * To skip content already written, pass the last content id the progress log
 * reported:
 *
 *   npx tsx --env-file=.env src/migrations/importStudioContent.ts --commit --start-after=13000
 *
 * Content is read in short keyset-paginated batches rather than one long
 * stream, and every write has a timeout. A run spans tens of thousands of rows,
 * and a single result stream held open that long dies silently when a network
 * hop drops it: MySQL closes its side, the client never hears, and the import
 * waits forever. A short query per batch cannot outlive a timeout, and a hung
 * write fails loudly with the id to resume from.
 *
 * PSEUDONYMISED BY DEFAULT. Author names, change-log authors and media
 * copyright authors are replaced with stable fake names, email addresses are
 * redacted from free text and content parameters, and author comments are
 * dropped. That needs `STUDIO_PSEUDONYM_SALT`; see `StudioPseudonymizer.ts`
 * for how to supply it. Pass `--with-identities` to import real identifying
 * information, which only the production import should do:
 *
 *   npx tsx --env-file=.env src/migrations/importStudioContent.ts --commit --with-identities
 */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import {
  loadStudioMysqlConfig,
  loadStudioPseudonymSalt,
} from "../config/env.js";
import type {
  IContentMetadata,
  ILibraryMetadata,
  ILibraryName,
  IUser,
} from "@lumieducation/h5p-server";
import { buildH5P } from "../h5p.js";
import logger, { childLogger } from "../logger.js";
import StudioPseudonymizer from "./StudioPseudonymizer.js";
import { H5P_DISABLE } from "../embed/displayOptions.js";

const log = childLogger("studio-import-content");

const COMMIT = process.argv.includes("--commit");
const WITH_IDENTITIES = process.argv.includes("--with-identities");

/** Content rows fetched per query. Parameters are LONGTEXT, so keep it modest. */
const BATCH_SIZE = 500;

/** Upper bound for one batch query. Generous: a batch normally takes milliseconds. */
const QUERY_TIMEOUT_MS = 120_000;

/** Upper bound for one content write. A healthy write takes milliseconds. */
const WRITE_TIMEOUT_MS = 60_000;

/**
 * Consecutive failed writes before the run aborts. One bad record fails alone;
 * a run of them means Mongo itself is unhealthy, and each further attempt
 * would wait out the driver's server selection timeout for nothing.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Content ids at or below this are skipped. 0 imports everything. */
function parseStartAfter(): number {
  const arg = process.argv.find((a) => a.startsWith("--start-after="));
  if (!arg) return 0;
  const n = Number(arg.split("=")[1]);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("--start-after= requires a non-negative integer content id.");
  }
  return n;
}

/** A write that did not settle in time, as distinct from one that failed. */
class TimeoutError extends Error {}

/** Rejects with a `TimeoutError` if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${what} timed out after ${ms} ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The importer acts as a system principal; Studio ownership lives in Conductor. */
const IMPORT_USER: IUser = {
  email: "",
  id: "studio-migration",
  name: "Studio Migration",
  type: "local",
};

type LibraryRow = {
  library_id: number;
  machine_name: string;
  title: string;
  major_version: number;
  minor_version: number;
  patch_version: number;
  runnable: number;
  fullscreen: number;
  embed_types: string;
  preloaded_js: string | null;
  preloaded_css: string | null;
  drop_library_css: string | null;
  restricted: number;
  add_to: string | null;
  metadata_settings: string | null;
};

type ContentRow = {
  id: number;
  library_id: number;
  parameters: string | null;
  filtered_parameters: string | null;
  title: string | null;
  a11y_title: string | null;
  authors: string | null;
  source: string | null;
  year_from: number | null;
  year_to: number | null;
  license: string | null;
  license_version: string | null;
  changes: string | null;
  license_extras: string | null;
  author_comments: string | null;
  default_language: string | null;
  disabled_features: number | null;
};

/** Studio stores path lists as comma-separated strings. */
function csvToPaths(value: string | null): { path: string }[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts.map((p) => ({ path: p })) : undefined;
}

function csvToList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Tolerates the malformed JSON that accumulates in a decade-old database. */
function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function run(): Promise<void> {
  // Read lazily, inside `run`, so starting the service never demands the
  // migration's MySQL credentials. `STUDIO_MYSQL_PASSWORD` stays optional: a
  // local Studio dump is commonly restored into a passwordless MySQL.
  const mysqlConfig = loadStudioMysqlConfig();
  const startAfter = parseStartAfter();

  // Built before connecting, and in a dry run too, so a missing or short salt
  // fails before any work rather than after a dry run that looked clean.
  const pseudonymizer = WITH_IDENTITIES
    ? null
    : new StudioPseudonymizer(loadStudioPseudonymSalt());
  const identities = pseudonymizer ? "pseudonymized" : "real";

  log.info(
    { mode: COMMIT ? "COMMIT" : "DRY RUN", identities, startAfter },
    COMMIT
      ? "Importing Studio libraries and content"
      : "Dry run: nothing will be written"
  );
  if (!pseudonymizer) {
    log.warn(
      { identities },
      "--with-identities set: real author names and contact details will be imported"
    );
  }

  const report = {
    mode: COMMIT ? "commit" : "dry-run",
    identities,
    startAfter,
    generatedAt: new Date().toISOString(),
    libraries: {
      read: 0,
      written: 0,
      alreadyInstalled: 0,
      failed: [] as string[],
    },
    content: {
      read: 0,
      written: 0,
      skippedMissingLibrary: [] as number[],
      unparseableParameters: [] as number[],
      failed: [] as { id: number; error: string }[],
      /**
       * Activities whose author switched an action bar feature off in Studio,
       * by feature. Each count is one bit of `disabled_features`.
       */
      displayOptions: { withAnyDisabled: 0, frame: 0, download: 0, embed: 0, copyright: 0 },
    },
    counterSeededTo: 0,
  };

  // Keepalive so an idle-looking connection is not dropped by a NAT or tunnel
  // between batches while libraries install.
  const conn = await mysql.createConnection({
    ...mysqlConfig,
    connectTimeout: 20_000,
    enableKeepAlive: true,
  });
  const stack = await buildH5P();

  try {
    await conn.query("SET SESSION TRANSACTION READ ONLY");

    // ---------------------------------------------------------------- libraries
    const [libRows] = await conn.query(
      `SELECT library_id, machine_name, title, major_version, minor_version,
              patch_version, runnable, fullscreen, embed_types, preloaded_js,
              preloaded_css, drop_library_css, restricted, add_to, metadata_settings
       FROM h5p_libraries`
    );
    const libraries = libRows as LibraryRow[];
    report.libraries.read = libraries.length;

    const libraryById = new Map<number, LibraryRow>(
      libraries.map((l) => [l.library_id, l])
    );

    const asLibraryName = (l: LibraryRow): ILibraryName => ({
      machineName: l.machine_name,
      majorVersion: l.major_version,
      minorVersion: l.minor_version,
    });

    // Dependencies between libraries, grouped by type.
    const [depRows] = await conn.query(
      `SELECT library_id, required_library_id, dependency_type
       FROM h5p_libraries_libraries`
    );
    const deps = new Map<number, { preloaded: ILibraryName[]; dynamic: ILibraryName[]; editor: ILibraryName[] }>();
    for (const row of depRows as any[]) {
      const required = libraryById.get(row.required_library_id);
      if (!required) continue;
      const bucket =
        deps.get(row.library_id) ??
        { preloaded: [], dynamic: [], editor: [] };
      const name = asLibraryName(required);
      if (row.dependency_type === "dynamic") bucket.dynamic.push(name);
      else if (row.dependency_type === "editor") bucket.editor.push(name);
      else bucket.preloaded.push(name);
      deps.set(row.library_id, bucket);
    }

    for (const l of libraries) {
      const d = deps.get(l.library_id);
      const metadata: ILibraryMetadata = {
        machineName: l.machine_name,
        majorVersion: l.major_version,
        minorVersion: l.minor_version,
        patchVersion: l.patch_version,
        title: l.title,
        runnable: l.runnable ? 1 : 0,
        fullscreen: l.fullscreen ? 1 : 0,
        embedTypes: csvToList(l.embed_types) as ("iframe" | "div")[],
        preloadedJs: csvToPaths(l.preloaded_js),
        preloadedCss: csvToPaths(l.preloaded_css),
        dropLibraryCss: csvToList(l.drop_library_css).map((machineName) => ({
          machineName,
        })),
        preloadedDependencies: d?.preloaded,
        dynamicDependencies: d?.dynamic,
        editorDependencies: d?.editor,
        ...(l.add_to ? { addTo: parseJson(l.add_to, undefined as any) } : {}),
        ...(l.metadata_settings
          ? { metadataSettings: parseJson(l.metadata_settings, undefined as any) }
          : {}),
      };

      const ubername = `${l.machine_name}-${l.major_version}.${l.minor_version}`;
      if (!COMMIT) {
        report.libraries.written += 1;
        continue;
      }
      try {
        // Ask rather than catching: `addLibrary` throws on an existing library,
        // and matching on the message text would silently turn a real failure
        // into a reported success the first time upstream rewords it.
        const name = asLibraryName(l);
        if (await stack.editor.libraryStorage.isInstalled(name)) {
          // Re-run: refresh the mutable part rather than reinstalling.
          await stack.editor.libraryStorage.updateAdditionalMetadata(name, {
            restricted: Boolean(l.restricted),
          });
          report.libraries.alreadyInstalled += 1;
        } else {
          await stack.editor.libraryStorage.addLibrary(
            metadata,
            Boolean(l.restricted)
          );
          report.libraries.written += 1;
        }
      } catch (err: any) {
        log.warn({ err, ubername }, "Library import failed");
        report.libraries.failed.push(ubername);
      }
    }
    log.info(
      {
        written: report.libraries.written,
        alreadyInstalled: report.libraries.alreadyInstalled,
        of: report.libraries.read,
      },
      "Libraries processed"
    );

    // ------------------------------------------------------------------ content
    // Preloaded dependencies of every content item, loaded up front in one
    // query rather than one round trip per row. Never query per row while a
    // result is still being read on `conn`: a MySQL connection runs one
    // command at a time, and an earlier streaming version of this loop
    // deadlocked on exactly that.
    const [contentDepRows] = await conn.query(
      `SELECT cl.content_id, l.machine_name, l.major_version, l.minor_version
       FROM h5p_content_libraries cl
       JOIN h5p_libraries l ON l.library_id = cl.library_id
       WHERE cl.dependency_type = 'preloaded'`
    );
    const contentDeps = new Map<number, ILibraryName[]>();
    for (const d of contentDepRows as any[]) {
      const list = contentDeps.get(d.content_id) ?? [];
      list.push({
        machineName: d.machine_name,
        majorVersion: d.major_version,
        minorVersion: d.minor_version,
      });
      contentDeps.set(d.content_id, list);
    }

    // Taken from the whole table, not from the rows read, so a run resumed
    // with --start-after still seeds the counter above every Studio id.
    const [maxRows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM h5p_content`
    );
    const maxId = Number((maxRows as any[])[0].max_id);

    // Keyset-paginated batches: 30k rows of LONGTEXT parameters would be
    // hundreds of MB buffered at once, and a single stream held open for the
    // whole run dies silently when a network hop drops it. See the header.
    // `lastId` is the last row fully handled, which is what --start-after
    // takes to resume.
    let lastId = startAfter;
    let consecutiveFailures = 0;
    for (;;) {
      const [batchRows] = await conn.query(
        {
          sql: `SELECT id, library_id, parameters, filtered_parameters, title, a11y_title,
                       authors, source, year_from, year_to, license, license_version,
                       changes, license_extras, author_comments, default_language,
                       disabled_features
                FROM h5p_content
                WHERE id > ?
                ORDER BY id
                LIMIT ?`,
          timeout: QUERY_TIMEOUT_MS,
        },
        [lastId, BATCH_SIZE]
      );
      const batch = batchRows as ContentRow[];
      if (!batch.length) break;

      for (const row of batch) {
        report.content.read += 1;

        const library = libraryById.get(row.library_id);
        if (!library) {
          report.content.skippedMissingLibrary.push(row.id);
          lastId = row.id;
          continue;
        }

        const rawParameters = parseJson<any | null>(row.parameters, null);
        if (rawParameters === null) {
          // Without parameters there is nothing to play; record and move on
          // rather than aborting an import of 30,000 records.
          report.content.unparseableParameters.push(row.id);
          lastId = row.id;
          continue;
        }

        const preloadedDependencies = contentDeps.get(row.id) ?? [];

        const p = pseudonymizer;
        const parameters = p ? p.parameters(rawParameters) : rawParameters;
        const authors = parseJson(row.authors, [] as any[]);
        const changes = parseJson(row.changes, [] as any[]);
        const scrub = (text: string) => (p ? p.scrubText(text) : text);

        const metadata: IContentMetadata = {
          title: row.title ?? `H5P Content ${row.id}`,
          mainLibrary: library.machine_name,
          language: row.default_language || "en",
          defaultLanguage: row.default_language || "en",
          license: row.license ?? "U",
          embedTypes: (csvToList(library.embed_types) as ("iframe" | "div")[])
            .length
            ? (csvToList(library.embed_types) as ("iframe" | "div")[])
            : ["iframe"],
          preloadedDependencies: preloadedDependencies.length
            ? preloadedDependencies
            : [
                {
                  machineName: library.machine_name,
                  majorVersion: library.major_version,
                  minorVersion: library.minor_version,
                },
              ],
          ...(row.a11y_title ? { a11yTitle: row.a11y_title } : {}),
          ...(row.license_version ? { licenseVersion: row.license_version } : {}),
          ...(row.year_from ? { yearFrom: String(row.year_from) } : {}),
          ...(row.year_to ? { yearTo: String(row.year_to) } : {}),
          ...(row.source ? { source: scrub(row.source) } : {}),
          ...(row.license_extras
            ? { licenseExtras: scrub(row.license_extras) }
            : {}),
          // Private notes shown only in the editor, so dropping them costs dev
          // nothing and removes the field most likely to name a person.
          ...(row.author_comments && !p
            ? { authorComments: row.author_comments }
            : {}),
          authors: (Array.isArray(authors) && p ? p.authors(authors) : authors) as any[],
          changes: (Array.isArray(changes) && p ? p.changes(changes) : changes) as any[],
        };

        // Studio's per-activity action bar choices. Stored for every row, 0
        // included, so a re-run also corrects a value changed in Studio.
        const disabledFeatures = Number(row.disabled_features) || 0;
        if (disabledFeatures) {
          const d = report.content.displayOptions;
          d.withAnyDisabled += 1;
          if (disabledFeatures & H5P_DISABLE.FRAME) d.frame += 1;
          if (disabledFeatures & H5P_DISABLE.DOWNLOAD) d.download += 1;
          if (disabledFeatures & H5P_DISABLE.EMBED) d.embed += 1;
          if (disabledFeatures & H5P_DISABLE.COPYRIGHT) d.copyright += 1;
        }

        if (!COMMIT) {
          report.content.written += 1;
        } else {
          // A timeout is not a per-row failure: it means the connection to
          // Mongo is unhealthy, and carrying on would only stack up more hung
          // writes. Abort with the id to resume from instead. The bitmask is
          // written in the same timed step, after the content it belongs to.
          const write = stack.editor.contentStorage
            .addContent(metadata, parameters, IMPORT_USER, String(row.id))
            .then(async (id) => {
              if (String(id) === String(row.id)) {
                await stack.contentStorage.setDisabledFeatures(id, disabledFeatures);
              }
              return id;
            });
          let written: string;
          try {
            written = await withTimeout(
              write,
              WRITE_TIMEOUT_MS,
              `Write of content ${row.id}`
            );
          } catch (err: any) {
            if (err instanceof TimeoutError) {
              throw new Error(
                `${err.message}. Mongo is not responding. Re-run with --start-after=${lastId}.`
              );
            }
            log.warn({ err, contentId: row.id }, "Content import failed");
            report.content.failed.push({
              id: row.id,
              error: err?.message ?? String(err),
            });
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              // Resume from before the failed streak, so it is retried.
              const resumeAfter =
                report.content.failed[report.content.failed.length - consecutiveFailures]
                  .id - 1;
              throw new Error(
                `${consecutiveFailures} consecutive content writes failed, last ` +
                  `with: ${err?.message ?? String(err)}. Mongo is likely ` +
                  `unreachable. Re-run with --start-after=${resumeAfter}.`
              );
            }
            lastId = row.id;
            continue;
          }
          consecutiveFailures = 0;
          if (written !== String(row.id)) {
            log.warn(
              { contentId: row.id, returned: written },
              "Content import failed: id not preserved"
            );
            report.content.failed.push({
              id: row.id,
              error: `id not preserved: asked for ${row.id}, storage returned ${written}`,
            });
            lastId = row.id;
            continue;
          }
          report.content.written += 1;
        }

        lastId = row.id;
      }

      log.info(
        { read: report.content.read, written: report.content.written, lastId },
        "Content progress"
      );
    }

    // Keep new authoring clear of every id Studio ever issued, including ones
    // whose rows were skipped above or before --start-after.
    report.counterSeededTo = maxId;
    if (COMMIT && maxId > 0) {
      await (stack.editor.contentStorage as any).seedCounter(maxId);
      log.info({ seq: maxId }, "Content id counter seeded");
    }
  } finally {
    await conn.end();
  }

  const outDir = path.resolve("migration-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(
    outDir,
    `h5p-content-import-${report.mode}-${stamp}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  process.stdout.write(
    `\n${COMMIT ? "IMPORT" : "DRY RUN"}\n` +
      `  Identities:                ${report.identities}\n` +
      `  Libraries read:            ${report.libraries.read}\n` +
      `  Libraries written:         ${report.libraries.written}\n` +
      `  Libraries already present: ${report.libraries.alreadyInstalled}
` +
      `  Libraries failed:          ${report.libraries.failed.length}\n` +
      `  Content read:              ${report.content.read}\n` +
      `  Content written:           ${report.content.written}\n` +
      `  Skipped, missing library:  ${report.content.skippedMissingLibrary.length}\n` +
      `  Skipped, bad parameters:   ${report.content.unparseableParameters.length}\n` +
      `  Content failed:            ${report.content.failed.length}\n` +
      `  Display options changed:   ${report.content.displayOptions.withAnyDisabled}` +
      ` (frame ${report.content.displayOptions.frame}, download ${report.content.displayOptions.download},` +
      ` embed ${report.content.displayOptions.embed}, copyright ${report.content.displayOptions.copyright})
` +
      `  Id counter seeded to:      ${report.counterSeededTo}\n` +
      `\nFiles are NOT copied by this script. Run the two aws s3 sync commands\n` +
      `in the header before serving any embed.\n` +
      `\nReport: ${reportPath}\n` +
      (COMMIT ? "" : "\nRe-run with --commit to write these records.\n")
  );
}

if (process.argv[1] && process.argv[1].includes("importStudioContent")) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "Studio content import failed");
      process.exit(1);
    });
}
