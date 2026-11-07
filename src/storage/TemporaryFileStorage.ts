import type { Readable } from "node:stream";
import type { S3 } from "@aws-sdk/client-s3";
import { S3TemporaryFileStorage } from "@lumieducation/h5p-mongos3";
import { H5pError, type IUser } from "@lumieducation/h5p-server";
import { validateFilename } from "./S3Utils.js";

type Options = ConstructorParameters<typeof S3TemporaryFileStorage>[1];

/**
 * Lumi's `S3TemporaryFileStorage` (GPL-3.0-or-later), with a stream that can
 * be closed.
 *
 * When a save copies an uploaded file into the activity, Lumi's
 * `ContentStorer` cleans up by calling `readable.close()` if it exists. An S3
 * response body has no `close()`, so a copy that failed part way left its
 * body unread and its socket held for good. Each such save took one socket
 * from the temporary bucket's pool, the same pool every upload needs. Here
 * the stream's `close()` destroys it, which is a no-op once it has been read.
 *
 * Also fixes upstream's range check, `rangeStart && rangeEnd`, which treats a
 * range starting at byte 0 as no range and returns the whole file.
 */
export default class TemporaryFileStorage extends S3TemporaryFileStorage {
  private bucket: string;
  private invalidCharactersRegexp?: RegExp;

  constructor(
    private client: S3,
    options: Options
  ) {
    super(client, options);
    this.bucket = options.s3Bucket;
    this.invalidCharactersRegexp = options.invalidCharactersRegexp;
  }

  override async getFileStream(
    filename: string,
    _user: IUser,
    rangeStart?: number,
    rangeEnd?: number
  ): Promise<Readable> {
    validateFilename(filename, this.invalidCharactersRegexp);
    if (!filename) {
      throw new H5pError("s3-temporary-storage:file-not-found", {}, 404);
    }
    const object = await this.client.getObject({
      Bucket: this.bucket,
      Key: filename,
      Range: rangeStart !== undefined && rangeEnd !== undefined ? `bytes=${rangeStart}-${rangeEnd}` : undefined,
    });
    const body = object.Body as Readable & { close?: () => void };
    body.close = () => body.destroy();
    return body;
  }
}
