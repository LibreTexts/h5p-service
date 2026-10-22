/**
 * Filename and bulk-delete helpers for the S3-backed storage.
 *
 * Derived from `S3Utils.ts` in @lumieducation/h5p-mongos3 (GPL-3.0-or-later),
 * which does not export them from its package entry point. Behaviour is
 * deliberately identical: these rules decide which filenames are legal in S3,
 * and diverging from upstream would make content that works under Lumi's
 * storage fail under ours.
 */
import { DeleteObjectsCommand, type S3 } from "@aws-sdk/client-s3";
import { H5pError } from "@lumieducation/h5p-server";

/**
 * The characters S3 either rejects or handles badly in keys. Anything outside
 * this set is removed by `sanitizeFilename` and rejected by `validateFilename`.
 */
const DEFAULT_INVALID_CHARACTERS = /[^A-Za-z0-9\-._!()@/]/g;

/** Throws if a filename cannot safely be used as part of an S3 key. */
export function validateFilename(
  filename: string,
  invalidCharactersRegExp?: RegExp
): void {
  if (/\.\.\//.test(filename)) {
    throw new H5pError("illegal-filename", { filename }, 400);
  }
  if (filename.startsWith("/")) {
    throw new H5pError("illegal-filename", { filename }, 400);
  }
  // A global regex carries lastIndex between calls, so build a fresh one per
  // check rather than reusing the module-level constant directly.
  const invalid = invalidCharactersRegExp ?? new RegExp(DEFAULT_INVALID_CHARACTERS.source, "g");
  if (invalid.test(filename)) {
    throw new H5pError("illegal-filename", { filename }, 400);
  }
}

/** Strips illegal characters and shortens a filename to fit the key limit. */
export function sanitizeFilename(
  filename: string,
  maxFileLength: number,
  invalidCharactersRegExp?: RegExp
): string {
  const invalid = invalidCharactersRegExp ?? new RegExp(DEFAULT_INVALID_CHARACTERS.source, "g");
  let cleaned = filename.replace(invalid, "");
  if (cleaned.length > maxFileLength) {
    const dot = cleaned.lastIndexOf(".");
    if (dot > 0 && cleaned.length - dot <= 10) {
      const ext = cleaned.substring(dot);
      cleaned = cleaned.substring(0, maxFileLength - ext.length) + ext;
    } else {
      cleaned = cleaned.substring(0, maxFileLength);
    }
  }
  return cleaned;
}

/**
 * Deletes many objects in batches.
 *
 * S3 caps `DeleteObjects` at 1000 keys per call, so a content object with more
 * files than that would silently lose the remainder in a single-shot delete.
 */
export async function deleteObjects(
  keys: string[],
  bucket: string,
  s3: S3
): Promise<void> {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      })
    );
  }
}
