import * as H5P from "@lumieducation/h5p-server";
import {
  initMongo,
  MongoS3LibraryStorage,
  S3TemporaryFileStorage,
} from "@lumieducation/h5p-mongos3";
import { S3 } from "@aws-sdk/client-s3";
import IntegerIdContentStorage from "./storage/IntegerIdContentStorage.js";
import CapabilityPermissionSystem from "./auth/CapabilityPermissionSystem.js";
import config from "./config.js";
import { childLogger } from "./logger.js";

const log = childLogger("h5p-core");

export interface H5PStack {
  editor: H5P.H5PEditor;
  player: H5P.H5PPlayer;
  config: H5P.H5PConfig;
  /**
   * The same storage the editor and player use, typed concretely for the
   * methods Lumi does not know about, such as the display-option bitmask.
   */
  contentStorage: IntegerIdContentStorage;
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
    // Lumi's default upload whitelist minus Flash, which no browser runs. SVG
    // is already absent from it, and must stay absent: an uploaded SVG can
    // carry script, and it would run on the embed origin ADAPT trusts.
    contentWhitelist:
      "json png jpg jpeg gif bmp tif tiff eot ttf woff woff2 otf webm mp4 ogg mp3 m4a wav txt pdf rtf doc docx xls xlsx ppt pptx odt ods odp xml csv diff patch md textile vtt webvtt gltf glb",
  });

  /**
   * Replaces Lumi's default, which allows everything. Public reads stay
   * public; every write needs a capability token. Installed even with
   * authoring off, so turning the editor routes on can never expose Lumi's
   * allow-all default.
   */
  const permissionSystem = new CapabilityPermissionSystem();

  const editor = new H5P.H5PEditor(
    new H5P.fsImplementations.InMemoryStorage(),
    h5pConfig,
    libraryStorage,
    contentStorage,
    temporaryStorage,
    undefined,
    undefined,
    { permissionSystem }
  );

  const player = new H5P.H5PPlayer(
    editor.libraryStorage,
    editor.contentStorage,
    h5pConfig,
    undefined,
    undefined,
    undefined,
    { permissionSystem }
  );

  // Return the model rather than HTML. The renderer is player-wide state, so
  // formatting inside it would make the output of concurrent requests depend on
  // whichever one set it last. Routes format the model themselves. The same
  // holds for the editor's renderer.
  player.setRenderer((model) => model);
  editor.setRenderer((model: any) => model);

  log.info(
    {
      contentBucket: config.s3.contentBucket,
      libraryBucket: config.s3.libraryBucket,
      coreApiVersion: `${h5pConfig.coreApiVersion.major}.${h5pConfig.coreApiVersion.minor}`,
    },
    "H5P stack initialized"
  );

  return { editor, player, config: h5pConfig, contentStorage };
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

/** How often to check whether the content type cache needs a refresh. */
const CONTENT_TYPE_CACHE_CHECK_MS = 60 * 60 * 1000;

/**
 * Fills the editor's content type cache from the H5P Hub at boot, then keeps
 * it fresh in the background.
 *
 * The cache lives in memory. Lumi fills an empty one inline, inside the
 * editor's first `content-type-cache` request, and its Hub client has no
 * timeout, so the first editor opened after each start waited about 7 s on
 * api.h5p.org. Refreshing here means no editor request waits on the Hub.
 * `updateIfNecessary` only calls the Hub once Lumi's refresh interval (a day)
 * has passed, and a failed refresh keeps the previous cache. Never awaited, so
 * a slow or unreachable Hub cannot delay startup.
 */
export function keepContentTypeCacheWarm(stack: H5PStack): void {
  const cache = stack.editor.contentTypeCache;
  let running = false;
  const refresh = async (): Promise<void> => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const updated = await cache.updateIfNecessary();
      if (updated) {
        log.info({ ms: Date.now() - started }, "Content type cache refreshed from the H5P Hub");
      } else if (!(await cache.getLastUpdate())) {
        log.warn({ ms: Date.now() - started }, "Content type cache is empty: the H5P Hub could not be reached");
      }
    } catch (err) {
      log.warn({ err }, "Content type cache refresh failed");
    } finally {
      running = false;
    }
  };
  void refresh();
  setInterval(() => void refresh(), CONTENT_TYPE_CACHE_CHECK_MS).unref();
}
