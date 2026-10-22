/**
 * Content storage keyed by LibreTexts Studio's integer content ids.
 *
 * Derived from `MongoS3ContentStorage` in @lumieducation/h5p-mongos3
 * (GPL-3.0-or-later). The logic is upstream's; the change is the identifier.
 *
 * ## Why this exists
 *
 * Upstream stores content under a Mongo `ObjectId`, coercing any supplied id
 * with `new ObjectId(contentId)`. Studio's ids are plain integers, and
 * `new ObjectId("31483")` throws. Two things made that unacceptable rather
 * than merely inconvenient:
 *
 *   1. `/h5p/{id}/embed` is baked into thousands of published LibreTexts
 *      textbook pages, keyed by that integer. It cannot change, and routing it
 *      through a translation table would put a lookup on the one path that must
 *      never fail.
 *   2. Content file S3 keys are `{contentId}/{filename}`. Keeping integers
 *      means the bucket layout matches Studio's `files/h5p/content/{id}/...`
 *      exactly, so migrating 33 GB across ~36k files is a plain `aws s3 sync`
 *      that can be re-run for a delta before cutover. Hex ids would have forced
 *      a per-directory rename of ~30k directories in flight.
 *
 * Mongo accepts any scalar as `_id`, so the content id is stored as a string
 * and no coercion happens anywhere.
 *
 * New content created after the migration draws from a counter seeded above
 * the highest migrated id, so ids stay numeric and never collide with Studio's.
 * The embed route matches `\d+`, so non-numeric ids would be unroutable.
 */
import type MongoDB from "mongodb";
import type { Stream, Readable } from "stream";
import { Upload } from "@aws-sdk/lib-storage";
import type { ObjectCannedACL, S3 } from "@aws-sdk/client-s3";
import {
  H5pError,
  type ContentId,
  type IContentMetadata,
  type IContentStorage,
  type IFileStats,
  type ILibraryName,
  type IUser,
} from "@lumieducation/h5p-server";
import { deleteObjects, sanitizeFilename, validateFilename } from "./S3Utils.js";
import { childLogger } from "../logger.js";

const log = childLogger("content-storage");

export type ContentDocument = {
  _id: string;
  metadata: IContentMetadata;
  parameters: any;
  creator: string;
};

export type CounterDocument = { _id: string; seq: number };

export default class IntegerIdContentStorage implements IContentStorage {
  private maxKeyLength: number;

  /**
   * @param counters collection holding the id sequence. Separate from the
   * content collection so an id allocation never contends with a content write.
   */
  constructor(
    private s3: S3,
    private mongodb: MongoDB.Collection<ContentDocument>,
    private counters: MongoDB.Collection<CounterDocument>,
    private options: {
      invalidCharactersRegexp?: RegExp;
      maxKeyLength?: number;
      s3Acl?: ObjectCannedACL;
      s3Bucket: string;
    }
  ) {
    // Upstream reserves 22 characters of the 1024-byte key budget for the id
    // and separator.
    this.maxKeyLength =
      options?.maxKeyLength !== undefined ? options.maxKeyLength - 22 : 1002;
  }

  /**
   * `{contentId}/{filename}` — identical in shape to upstream, and now
   * identical to Studio's on-disk layout because the id is the same integer.
   */
  private static getS3Key(contentId: ContentId, filename: string): string {
    const key = `${contentId}/${filename}`;
    if (key.length > 1024) {
      throw new H5pError(
        "mongo-s3-content-storage:filename-too-long",
        { filename },
        400
      );
    }
    return key;
  }

  /**
   * Allocates the next content id.
   *
   * `findOneAndUpdate` with `$inc` is atomic, so concurrent creates cannot
   * receive the same id. The counter is seeded by the migration to sit above
   * the highest id imported from Studio.
   */
  private async nextContentId(): Promise<string> {
    const result = await this.counters.findOneAndUpdate(
      { _id: "contentId" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    const seq = (result as any)?.seq ?? (result as any)?.value?.seq;
    if (typeof seq !== "number") {
      throw new H5pError("mongo-s3-content-storage:mongo-add-update-error", {}, 500);
    }
    return String(seq);
  }

  async addContent(
    metadata: IContentMetadata,
    content: any,
    user: IUser,
    contentId?: ContentId
  ): Promise<ContentId> {
    const id = contentId ?? (await this.nextContentId());
    try {
      // `_id` is deliberately absent from the replacement: the driver rejects
      // it there, and on upsert Mongo takes it from the filter's equality.
      await this.mongodb.replaceOne(
        { _id: id },
        { metadata, parameters: content, creator: user.id },
        { upsert: true }
      );
      return id;
    } catch (error: any) {
      log.error({ err: error, contentId: id }, "Failed to write content");
      throw new H5pError(
        "mongo-s3-content-storage:mongo-add-update-error",
        {},
        500
      );
    }
  }

  async addFile(
    contentId: ContentId,
    filename: string,
    stream: Stream,
    user: IUser
  ): Promise<void> {
    validateFilename(filename, this.options.invalidCharactersRegexp);
    try {
      await new Upload({
        client: this.s3,
        params: {
          ACL: this.options.s3Acl ?? "private",
          Body: stream as Readable,
          Bucket: this.options.s3Bucket,
          Key: IntegerIdContentStorage.getS3Key(contentId, filename),
          Metadata: { owner: user.id },
        },
      }).done();
    } catch (error: any) {
      log.error({ err: error, contentId, filename }, "S3 upload failed");
      throw new H5pError(
        "mongo-s3-content-storage:s3-upload-error",
        { filename },
        500
      );
    }
  }

  async contentExists(contentId: ContentId): Promise<boolean> {
    const found = await this.mongodb.findOne(
      { _id: String(contentId) },
      { projection: { _id: true } }
    );
    return Boolean(found);
  }

  async deleteContent(contentId: ContentId, user?: IUser): Promise<void> {
    try {
      const filesToDelete = await this.listFiles(contentId, user as IUser);
      await deleteObjects(
        filesToDelete.map((f) =>
          IntegerIdContentStorage.getS3Key(contentId, f)
        ),
        this.options.s3Bucket,
        this.s3
      );
      const result = await this.mongodb.deleteOne({ _id: String(contentId) });
      if (result.deletedCount !== 1) {
        throw new Error("MongoDB document could not be deleted.");
      }
    } catch (error: any) {
      log.error({ err: error, contentId }, "Failed to delete content");
      throw new H5pError(
        "mongo-s3-content-storage:deleting-content-error",
        {},
        500
      );
    }
  }

  async deleteFile(
    contentId: ContentId,
    filename: string,
    _user?: IUser
  ): Promise<void> {
    try {
      await this.s3.deleteObject({
        Bucket: this.options.s3Bucket,
        Key: IntegerIdContentStorage.getS3Key(contentId, filename),
      });
    } catch (error: any) {
      log.error({ err: error, contentId, filename }, "Failed to delete file");
      throw new H5pError(
        "mongo-s3-content-storage:deleting-file-error",
        { filename },
        500
      );
    }
  }

  async fileExists(contentId: ContentId, filename: string): Promise<boolean> {
    validateFilename(filename, this.options.invalidCharactersRegexp);
    if (!contentId) {
      throw new H5pError("mongo-s3-content-storage:content-not-found", {}, 404);
    }
    try {
      await this.s3.headObject({
        Bucket: this.options.s3Bucket,
        Key: IntegerIdContentStorage.getS3Key(contentId, filename),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getFileStats(
    contentId: string,
    filename: string,
    _user: IUser
  ): Promise<IFileStats> {
    validateFilename(filename, this.options.invalidCharactersRegexp);
    try {
      const head = await this.s3.headObject({
        Bucket: this.options.s3Bucket,
        Key: IntegerIdContentStorage.getS3Key(contentId, filename),
      });
      return {
        size: head.ContentLength as number,
        birthtime: head.LastModified as Date,
      };
    } catch {
      throw new H5pError("content-file-missing", { filename, contentId }, 404);
    }
  }

  async getFileStream(
    contentId: ContentId,
    filename: string,
    _user: IUser,
    rangeStart?: number,
    rangeEnd?: number
  ): Promise<Readable> {
    validateFilename(filename, this.options.invalidCharactersRegexp);
    if (!contentId) {
      throw new H5pError("mongo-s3-content-storage:content-not-found", {}, 404);
    }
    const object = await this.s3.getObject({
      Bucket: this.options.s3Bucket,
      Key: IntegerIdContentStorage.getS3Key(contentId, filename),
      Range:
        rangeStart !== undefined && rangeEnd !== undefined
          ? `bytes=${rangeStart}-${rangeEnd}`
          : undefined,
    });
    return object.Body as Readable;
  }

  async getMetadata(
    contentId: string,
    _user?: IUser
  ): Promise<IContentMetadata> {
    const doc = await this.mongodb.findOne({ _id: String(contentId) });
    if (!doc) {
      throw new H5pError("mongo-s3-content-storage:content-not-found", {}, 404);
    }
    return doc.metadata;
  }

  async getParameters(contentId: string, _user?: IUser): Promise<any> {
    const doc = await this.mongodb.findOne({ _id: String(contentId) });
    if (!doc) {
      throw new H5pError("mongo-s3-content-storage:content-not-found", {}, 404);
    }
    return doc.parameters;
  }

  async getUsage(
    library: ILibraryName
  ): Promise<{ asDependency: number; asMainLibrary: number }> {
    const dependencyMatch = {
      $elemMatch: {
        machineName: library.machineName,
        majorVersion: library.majorVersion,
        minorVersion: library.minorVersion,
      },
    };
    const [asMainLibrary, asDependency] = await Promise.all([
      this.mongodb.countDocuments({
        $and: [
          { "metadata.mainLibrary": library.machineName },
          { "metadata.preloadedDependencies": dependencyMatch },
        ],
      } as any),
      this.mongodb.countDocuments({
        $and: [
          { "metadata.mainLibrary": { $ne: library.machineName } },
          {
            $or: [
              { "metadata.preloadedDependencies": dependencyMatch },
              { "metadata.dynamicDependencies": dependencyMatch },
              { "metadata.editorDependencies": dependencyMatch },
            ],
          },
        ],
      } as any),
    ]);
    return { asMainLibrary, asDependency };
  }

  async listContent(_user?: IUser): Promise<ContentId[]> {
    try {
      const cursor = this.mongodb.find({}, { projection: { _id: true } });
      return (await cursor.toArray()).map((doc) => String(doc._id));
    } catch (error: any) {
      log.error({ err: error }, "Failed to list content");
      throw new H5pError(
        "mongo-s3-content-storage:listing-content-error",
        {},
        500
      );
    }
  }

  async listFiles(contentId: ContentId, _user: IUser): Promise<string[]> {
    const prefix = IntegerIdContentStorage.getS3Key(contentId, "");
    let files: string[] = [];
    try {
      let ret: any;
      do {
        ret = await this.s3.listObjectsV2({
          Bucket: this.options.s3Bucket,
          Prefix: prefix,
          ContinuationToken: ret?.NextContinuationToken,
          MaxKeys: 1000,
        });
        files = files.concat(
          (ret.Contents ?? []).map((c: any) => c.Key.substring(prefix.length))
        );
      } while (ret.IsTruncated && ret.NextContinuationToken);
    } catch {
      // No objects under the prefix is normal for content with no files.
      return [];
    }
    return files;
  }

  sanitizeFilename(filename: string): string {
    return sanitizeFilename(
      filename,
      this.maxKeyLength,
      this.options?.invalidCharactersRegexp
    );
  }

  /**
   * Raises the id counter so newly created content never reuses a Studio id.
   * Called by the migration once content is imported.
   */
  async seedCounter(atLeast: number): Promise<void> {
    await this.counters.updateOne(
      { _id: "contentId" },
      { $max: { seq: atLeast } },
      { upsert: true }
    );
  }
}
