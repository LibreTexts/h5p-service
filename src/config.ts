import path from "node:path";
import {
  optional,
  optionalEnum,
  optionalInt,
  requiredCspSourceList,
  requiredHostList,
  requiredOrigin,
  requiredOriginList,
  requiredRegion,
  required,
} from "./config/env.js";

/**
 * Service configuration, validated eagerly at import.
 *
 * Values that describe a particular deployment's topology carry no defaults.
 * This repository is public, so a default of `https://adapt.libretexts.org` or
 * `us-west-2` would be inherited silently by anyone who forks it, and a
 * production deploy could come up on an inherited value without complaint.
 *
 * Values that are internal to the service, or coupled to the image layout,
 * keep their defaults: restating them in every deployment adds risk rather
 * than removing it.
 */

const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;

const NODE_ENVS = ["development", "test", "production"] as const;

const nodeEnv = optionalEnum("NODE_ENV", NODE_ENVS, "development");

const config = {
  port: optionalInt("PORT", 5100, 1, 65535),
  nodeEnv,
  logLevel: optionalEnum(
    "LOG_LEVEL",
    LOG_LEVELS,
    nodeEnv === "production" ? "info" : "debug"
  ),

  /**
   * Public origin this service answers on.
   *
   * Used for startup logging and operator diagnostics only. The embed document
   * deliberately emits same-origin relative URLs (see `embed/renderer.ts`), so
   * a wrong value here does not break published embeds. It is required so that
   * every deployment states its own identity rather than inheriting one.
   *
   * The production URL contract is documented in the README, not enforced here.
   */
  baseUrl: requiredOrigin("BASE_URL"),

  mongo: {
    url: required("MONGODB_URL"),
    db: optional("MONGODB_DB", "h5p"),
    contentCollection: optional("MONGODB_CONTENT_COLLECTION", "h5p_content"),
    libraryCollection: optional("MONGODB_LIBRARY_COLLECTION", "h5p_libraries"),
    // Holds the content-id sequence. Separate from content so allocating an id
    // never contends with a content write.
    counterCollection: optional("MONGODB_COUNTER_COLLECTION", "h5p_counters"),
  },

  s3: {
    contentBucket: required("S3_CONTENT_BUCKET"),
    libraryBucket: required("S3_LIBRARY_BUCKET"),
    temporaryBucket: required("S3_TEMPORARY_BUCKET"),
    /**
     * Set for S3-compatible storage (MinIO in local development). Left unset,
     * the AWS SDK resolves the real endpoint from the region.
     */
    endpoint: process.env.AWS_S3_ENDPOINT,
    region: requiredRegion("AWS_REGION"),
  },

  /**
   * On-disk locations of the H5P client libraries, populated by
   * `npm run fetch:h5p-core`. These are the MIT-licensed browser runtime from
   * h5p-php-library and h5p-editor-php-library, not the GPL server code.
   *
   * Defaulted rather than required: the paths are coupled to the Dockerfile's
   * COPY layout and must not vary per deployment.
   */
  h5p: {
    corePath: path.resolve(optional("H5P_CORE_PATH", "h5p/core")),
    editorPath: path.resolve(optional("H5P_EDITOR_PATH", "h5p/editor")),
  },

  embed: {
    /**
     * Origins allowed to drive the embed's styling API.
     *
     * Studio accepted `{elements}` and `{templates}` style-injection messages
     * from any origin with no validation, which let any page that framed an
     * activity rewrite its DOM. The capability is reproduced because ADAPT
     * depends on it; the open trust model is not.
     */
    allowedParentOrigins: requiredOriginList("ALLOWED_EMBED_PARENT_ORIGINS"),

    /** Space-separated source list for the embed route's `frame-ancestors`. */
    frameAncestors: requiredCspSourceList("EMBED_FRAME_ANCESTORS"),

    /**
     * Origins where the embed hides its export, embed and H5P links, because
     * the host application provides its own controls. ADAPT is the only such
     * host today.
     */
    adaptReferrers: requiredOriginList("EMBED_ADAPT_REFERRERS"),

    /**
     * Parent hosts treated as first-party. The attribution badge is shown to
     * everyone else. Matched by exact host or dot-suffix, never substring.
     */
    trustedParentHosts: requiredHostList("EMBED_TRUSTED_PARENT_HOSTS"),

    /**
     * Attribution badge shown when the embed is framed by an untrusted host.
     * Optional throughout: with no href the badge is not rendered at all, so a
     * deployment that is not LibreTexts shows no LibreTexts branding.
     */
    badge: {
      href: optional("EMBED_BADGE_HREF", ""),
      logoUrl: optional("EMBED_BADGE_LOGO_URL", ""),
      label: optional("EMBED_BADGE_LABEL", ""),
    },
  },
};

export default config;
