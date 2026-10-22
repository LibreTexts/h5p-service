/**
 * Fetches the H5P client libraries into `h5p/core` and `h5p/editor`.
 *
 * These are the browser-side H5P runtime (MIT), not the GPL server code. They
 * are not published to npm, so they are downloaded rather than vendored, which
 * also keeps the repository free of a few megabytes of third-party assets.
 *
 * The default versions match what LibreTexts Studio ran in production:
 * `h5p/h5p-core` 1.27.0 and `h5p/h5p-editor` 1.25. They also match the core API
 * version `@lumieducation/h5p-server` 10.0.4 targets (1.27), which is what makes
 * Studio's existing content types load unchanged. Do not bump these casually.
 *
 *   node scripts/fetch-h5p-core.mjs [coreRef] [editorRef]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  readdirSync,
  renameSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CORE_REF = "1.27.0";
const DEFAULT_EDITOR_REF = "1.25";

/**
 * Expected SHA-256 of each pinned tarball, keyed `<repo>@<ref>`.
 *
 * Without this the image build trusts whatever bytes github.com returns, and a
 * moved or compromised upstream tag would put arbitrary JavaScript into every
 * served embed.
 *
 * A mismatch means one of two things: the upstream tag was moved, or the
 * download was tampered with. Verify the tag still points at the commit you
 * expect before touching these values -- do not update a digest to make a
 * failing fetch pass.
 *
 * Regenerate for a new ref with:
 *   curl -sL https://github.com/h5p/<repo>/archive/<ref>.tar.gz | sha256sum
 */
const DIGESTS = {
  "h5p-php-library@1.27.0":
    "b0a3c72bf5256222f830488b1e4d34def77755c6fdd1256a014f5674206de782",
  "h5p-editor-php-library@1.25":
    "2ea29ddd58ffb821b6a62252cd9dcfced712180190a4f3ec0bd1a9d3271fbf5c",
};

/** Set to bypass verification when fetching a ref with no recorded digest. */
const ALLOW_UNVERIFIED = process.env.H5P_ALLOW_UNVERIFIED_REF === "1";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(projectRoot, "h5p");

const coreRef = process.argv[2] || DEFAULT_CORE_REF;
const editorRef = process.argv[3] || DEFAULT_EDITOR_REF;

/**
 * Downloads a GitHub tarball and moves its single top-level directory into
 * `dest`. Tarballs rather than zips because `tar` is present on Alpine, modern
 * Windows and macOS, whereas `unzip` is not.
 */
async function fetchInto(repo, ref, dest) {
  const tmp = join(base, "tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const url = `https://github.com/h5p/${repo}/archive/${ref}.tar.gz`;
  const archive = join(tmp, "archive.tar.gz");

  console.log(`Downloading ${repo}@${ref}...`);
  // Node's built-in fetch rather than shelling out to curl, which resolves to
  // different binaries across the shells this runs in.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());

  const actual = createHash("sha256").update(body).digest("hex");
  const expected = DIGESTS[`${repo}@${ref}`];
  if (expected) {
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${repo}@${ref}\n` +
          `  expected ${expected}\n` +
          `  actual   ${actual}\n` +
          `Verify the upstream tag has not moved before updating DIGESTS.`
      );
    }
    console.log(`  checksum ok (${actual.slice(0, 12)}...)`);
  } else if (ALLOW_UNVERIFIED) {
    console.warn(
      `  WARNING: no recorded digest for ${repo}@${ref}; proceeding unverified.\n` +
        `  Record this digest in DIGESTS if the ref is becoming the pinned one:\n` +
        `    ${actual}`
    );
  } else {
    throw new Error(
      `No recorded SHA-256 for ${repo}@${ref}. Its digest is ${actual}.\n` +
        `Add it to DIGESTS in this file, or set H5P_ALLOW_UNVERIFIED_REF=1 to ` +
        `fetch it without verification.`
    );
  }

  writeFileSync(archive, body);

  // Run tar inside the temp directory with a bare filename. Passing a Windows
  // absolute path to `-C` breaks under the MSYS tar that Git for Windows puts
  // ahead of the system one on PATH.
  execFileSync("tar", ["-xzf", "archive.tar.gz"], {
    cwd: tmp,
    stdio: "inherit",
  });

  const extracted = readdirSync(tmp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (extracted.length !== 1) {
    throw new Error(
      `Expected exactly one directory in ${repo}@${ref}, found ${extracted.length}`
    );
  }

  rmSync(dest, { recursive: true, force: true });
  renameSync(join(tmp, extracted[0]), dest);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`  -> ${dest}`);
}

mkdirSync(base, { recursive: true });
await fetchInto("h5p-php-library", coreRef, join(base, "core"));
await fetchInto("h5p-editor-php-library", editorRef, join(base, "editor"));

/**
 * The resizer is the one file published textbook pages load directly, by a path
 * that is baked into thousands of embed snippets. If it is missing the embeds
 * still render but never size themselves, which is easy to miss in review and
 * obvious to every student. Fail the fetch instead.
 */
const resizer = join(base, "core", "js", "h5p-resizer.js");
if (!existsSync(resizer)) {
  console.error(`\nERROR: h5p-resizer.js missing at ${resizer}`);
  console.error("Published embeds depend on it. Check the core version ref.");
  process.exit(1);
}

console.log(`\nH5P client libraries ready (core ${coreRef}, editor ${editorRef}).`);
