import * as H5P from "@lumieducation/h5p-server";
import {
  initMongo,
  MongoS3LibraryStorage,
  S3TemporaryFileStorage,
} from "@lumieducation/h5p-mongos3";
import { S3 } from "@aws-sdk/client-s3";
import IntegerIdContentStorage from "./storage/IntegerIdContentStorage.js";
import config from "./config.js";
import { childLogger } from "./logger.js";

const log = childLogger("h5p-core");

export interface H5PStack {
  editor: H5P.H5PEditor;
  player: H5P.H5PPlayer;
  config: H5P.H5PConfig;
}

/**
 * Builds the H5P editor and player against MongoDB and S3.
 *
 * Phase 1 serves and embeds existing activities; authoring arrives in phase 2.
 * The editor is still constructed because `h5pAjaxExpressRouter` takes one, and
 * because it owns the library and content managers the player reads through.
 */
export async function buildH5P(): Promise<H5PStack> {
  /**
   * Constructed directly rather than through h5p-mongos3's `initS3`, which
   * throws unless AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are both set in
   * the environment. That wrapper does nothing else this service needs: it
   * reads the same four variables off `process.env` and calls this same
   * constructor, so dropping it costs no behaviour and removes the demand for
   * a long-lived IAM user.
   *
   * No `credentials` property on purpose. Omitting it is what engages the AWS
   * SDK's default provider chain, which resolves an ECS or EKS task role, an
   * EC2 instance profile, a shared config profile, or the environment
   * variables themselves. A deployment that wants static keys still sets the
   * same two variables and the chain's own environment provider picks them up.
   */
  const s3 = new S3({
    region: config.s3.region,
    ...(config.s3.endpoint
      ? { endpoint: config.s3.endpoint, forcePathStyle: true }
      : {}),
  });

  const db = await initMongo(config.mongo.url, config.mongo.db);

  // Not Lumi's MongoS3ContentStorage: that one coerces ids to ObjectId, and
  // Studio's integer content ids are the published embed contract. See
  // storage/IntegerIdContentStorage.ts.
  const contentStorage = new IntegerIdContentStorage(
    s3,
    db.collection(config.mongo.contentCollection),
    db.collection(config.mongo.counterCollection),
    { s3Bucket: config.s3.contentBucket }
  );

  const libraryStorage = new MongoS3LibraryStorage(
    s3,
    db.collection(config.mongo.libraryCollection),
    { s3Bucket: config.s3.libraryBucket }
  );

  const temporaryStorage = new S3TemporaryFileStorage(s3, {
    s3Bucket: config.s3.temporaryBucket,
  });

  /**
   * `baseUrl` is relative on purpose. The embed document emits same-origin
   * relative URLs (see `embed/renderer.ts`), so nothing here derives an
   * absolute origin from `config.baseUrl` -- that value is operator
   * diagnostics only. Mounting the H5P routes under `/h5p` keeps every legacy
   * Studio path shape intact.
   */
  const h5pConfig = new H5P.H5PConfig(new H5P.fsImplementations.InMemoryStorage(), {
    baseUrl: "/h5p",
    // Studio ran with export and embed enabled, so the player's action bar keeps
    // offering both.
    setFinishedEnabled: false,
    contentUserStateSaveInterval: false,
  });

  const editor = new H5P.H5PEditor(
    new H5P.fsImplementations.InMemoryStorage(),
    h5pConfig,
    libraryStorage,
    contentStorage,
    temporaryStorage
  );

  const player = new H5P.H5PPlayer(
    editor.libraryStorage,
    editor.contentStorage,
    h5pConfig
  );

  // Return the model rather than HTML. The renderer is player-wide state, so
  // formatting inside it would make the output of concurrent requests depend on
  // whichever one set it last. Routes format the model themselves.
  player.setRenderer((model) => model);

  log.info(
    {
      contentBucket: config.s3.contentBucket,
      libraryBucket: config.s3.libraryBucket,
      coreApiVersion: `${h5pConfig.coreApiVersion.major}.${h5pConfig.coreApiVersion.minor}`,
    },
    "H5P stack initialized"
  );

  return { editor, player, config: h5pConfig };
}

/**
 * The anonymous viewer used for embed playback.
 *
 * Studio's embed route never checked access: any content id was publicly
 * embeddable regardless of whether the owning node was published. Published
 * textbooks depend on that, so it is reproduced deliberately rather than
 * tightened here. Access decisions belong in Conductor, which owns the activity
 * record.
 */
export function anonymousUser(): H5P.IUser {
  return {
    email: "",
    id: "anonymous",
    name: "Anonymous",
    type: "local",
  };
}
