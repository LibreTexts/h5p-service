import type { Readable } from "node:stream";
import type { S3 } from "@aws-sdk/client-s3";
import { MongoS3LibraryStorage } from "@lumieducation/h5p-mongos3";
import { LibraryName, streamToString, type ILibraryName } from "@lumieducation/h5p-server";
import { validateFilename } from "./S3Utils.js";

type Collection = ConstructorParameters<typeof MongoS3LibraryStorage>[1];
type Options = ConstructorParameters<typeof MongoS3LibraryStorage>[2];

/**
 * Lumi's `MongoS3LibraryStorage` (GPL-3.0-or-later), opening file downloads on
 * their own S3 client.
 *
 * A download holds a socket for as long as the client takes to read it, so
 * downloads and quick calls cannot share a pool: a full pool of downloads would
 * stall the HEADs and JSON reads that every embed and the editor wait on. See
 * `routes/files.ts`.
 *
 * Upstream reads semantics and language files through `getFileStream`, so
 * `getFileAsString` is overridden to keep those on the quick pool. Those reads
 * finish on their own and never wait on a client.
 */
export default class StreamingLibraryStorage extends MongoS3LibraryStorage {
  private bucket: string;
  private invalidCharactersRegexp?: RegExp;

  constructor(
    s3: S3,
    mongodb: Collection,
    options: Options,
    private streamS3: S3
  ) {
    super(s3, mongodb, options);
    this.bucket = options.s3Bucket;
    this.invalidCharactersRegexp = options.invalidCharactersRegexp;
  }

  override async getFileStream(library: ILibraryName, file: string): Promise<Readable> {
    // library.json lives in MongoDB, not S3.
    if (file === "library.json") return super.getFileStream(library, file);
    validateFilename(file, this.invalidCharactersRegexp);
    const object = await this.streamS3.getObject({
      Bucket: this.bucket,
      Key: `${LibraryName.toUberName(library)}/${file}`,
    });
    return object.Body as Readable;
  }

  override async getFileAsString(library: ILibraryName, file: string): Promise<string> {
    return streamToString(await super.getFileStream(library, file));
  }
}
