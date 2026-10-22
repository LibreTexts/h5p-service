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
 */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { loadStudioMysqlConfig } from "../config/env.js";
import type {
  IContentMetadata,
  ILibraryMetadata,
  ILibraryName,
  IUser,
} from "@lumieducation/h5p-server";
import { buildH5P } from "../h5p.js";
import logger, { childLogger } from "../logger.js";

const log = childLogger("studio-import-content");

const COMMIT = process.argv.includes("--commit");

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

  log.info(
    { mode: COMMIT ? "COMMIT" : "DRY RUN" },
    COMMIT
      ? "Importing Studio libraries and content"
      : "Dry run: nothing will be written"
  );

  const report = {
    mode: COMMIT ? "commit" : "dry-run",
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
    },
    counterSeededTo: 0,
  };

  const conn = await mysql.createConnection(mysqlConfig);
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
    // Streamed: 30k rows of LONGTEXT parameters would be hundreds of MB if
    // buffered, and mysql2's default query path buffers the whole result set.
    const stream = (conn as any).connection
      .query(
        `SELECT id, library_id, parameters, filtered_parameters, title, a11y_title,
                authors, source, year_from, year_to, license, license_version,
                changes, license_extras, author_comments, default_language
         FROM h5p_content ORDER BY id`
      )
      .stream();

    let maxId = 0;
    for await (const raw of stream) {
      const row = raw as ContentRow;
      report.content.read += 1;
      maxId = Math.max(maxId, row.id);

      const library = libraryById.get(row.library_id);
      if (!library) {
        report.content.skippedMissingLibrary.push(row.id);
        continue;
      }

      const parameters = parseJson<any | null>(row.parameters, null);
      if (parameters === null) {
        // Without parameters there is nothing to play; record and move on
        // rather than aborting an import of 30,000 records.
        report.content.unparseableParameters.push(row.id);
        continue;
      }

      const [depRowsForContent] = await conn.query(
        `SELECT l.machine_name, l.major_version, l.minor_version
         FROM h5p_content_libraries cl
         JOIN h5p_libraries l ON l.library_id = cl.library_id
         WHERE cl.content_id = ? AND cl.dependency_type = 'preloaded'`,
        [row.id]
      );
      const preloadedDependencies = (depRowsForContent as any[]).map((d) => ({
        machineName: d.machine_name,
        majorVersion: d.major_version,
        minorVersion: d.minor_version,
      }));

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
        ...(row.source ? { source: row.source } : {}),
        ...(row.license_extras ? { licenseExtras: row.license_extras } : {}),
        ...(row.author_comments ? { authorComments: row.author_comments } : {}),
        authors: parseJson(row.authors, [] as any[]),
        changes: parseJson(row.changes, [] as any[]),
      };

      if (!COMMIT) {
        report.content.written += 1;
      } else {
        try {
          const written = await stack.editor.contentStorage.addContent(
            metadata,
            parameters,
            IMPORT_USER,
            String(row.id)
          );
          if (written !== String(row.id)) {
            throw new Error(
              `id not preserved: asked for ${row.id}, storage returned ${written}`
            );
          }
          report.content.written += 1;
        } catch (err: any) {
          log.warn({ err, contentId: row.id }, "Content import failed");
          report.content.failed.push({
            id: row.id,
            error: err?.message ?? String(err),
          });
        }
      }

      if (report.content.read % 1000 === 0) {
        log.info(
          { read: report.content.read, written: report.content.written },
          "Content progress"
        );
      }
    }

    // Keep new authoring clear of every id Studio ever issued, including ones
    // whose rows were skipped above.
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
