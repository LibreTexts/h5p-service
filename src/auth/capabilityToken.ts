/**
 * Verifies the capability tokens Conductor signs for H5P authoring.
 *
 * Conductor owns authorship and access, and this service owns content. A
 * capability token is how the one tells the other "this request may do these
 * actions to this content id", without this service ever modelling users or
 * ownership. See H5P_AUTHORING_DESIGN.md section 1 in the migration workspace.
 *
 * Conductor signs with an Ed25519 private key and this service only ever holds
 * the public keys, so reading this service's environment is not enough to
 * mint edit rights.
 */
import { createLocalJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import type { Ed25519PublicJwk } from "../config/env.js";

export const CAPABILITY_ISSUER = "conductor";
export const CAPABILITY_AUDIENCE = "h5p-service";

/**
 * The longest a token may live, measured from `iat`. Conductor issues them for
 * 15 minutes and refreshes them while the editor is open. The extra minute
 * absorbs clock drift between the two services.
 */
export const CAPABILITY_MAX_AGE = "16m";

/** Clock drift tolerated on `exp`, `iat` and `nbf`, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * What a token may grant.
 *
 * - `edit`: save content under the token's `cid`.
 * - `create`: use the editor for an activity that has no content id yet.
 * - `delete`: delete the content under the token's `cid`.
 * - `allocate`: take the next content id. Server to server only.
 * - `libraries`: install and update H5P libraries. Admin tokens only, never
 *   an author's (design decision 4), because a library is arbitrary script on
 *   the embed origin ADAPT trusts.
 */
export const CAPABILITY_ACTIONS = ["edit", "create", "delete", "allocate", "libraries"] as const;
export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

/** Actions that only make sense for one particular content id. */
const ACTIONS_NEEDING_CID: readonly CapabilityAction[] = ["edit", "delete"];

export type Capability = {
  /** Conductor user uuid, or `conductor-service` for server-to-server calls. */
  subject: string;
  /** The content id the token is scoped to, as the string Lumi uses. */
  contentId?: string;
  actions: ReadonlySet<CapabilityAction>;
  /** Token id, logged with every write for audit. */
  tokenId: string;
  expiresAt: Date;
};

/** Why a token was refused. Logged, never sent back to the caller. */
export type CapabilityRejection =
  | "expired"
  | "bad-signature"
  | "unknown-key"
  | "bad-claims"
  | "malformed";

export class CapabilityTokenError extends Error {
  constructor(
    readonly reason: CapabilityRejection,
    detail: string
  ) {
    super(detail);
  }
}

export type CapabilityVerifier = (token: string) => Promise<Capability>;

/**
 * Builds a verifier for a fixed set of public keys. Throws
 * `CapabilityTokenError` for any token it will not honour.
 */
export function createCapabilityVerifier(keys: Ed25519PublicJwk[]): CapabilityVerifier {
  const keySet = createLocalJWKSet({ keys });

  return async (token: string): Promise<Capability> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        algorithms: ["EdDSA"],
        issuer: CAPABILITY_ISSUER,
        audience: CAPABILITY_AUDIENCE,
        maxTokenAge: CAPABILITY_MAX_AGE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp", "iat", "sub", "jti"],
      }));
    } catch (err) {
      throw toRejection(err);
    }
    return toCapability(payload);
  };
}

function toRejection(err: unknown): CapabilityTokenError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof errors.JWTExpired) return new CapabilityTokenError("expired", message);
  if (err instanceof errors.JWSSignatureVerificationFailed) {
    return new CapabilityTokenError("bad-signature", message);
  }
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
    return new CapabilityTokenError("unknown-key", message);
  }
  if (err instanceof errors.JWTClaimValidationFailed) {
    // maxTokenAge reports through this error too: a token older than
    // CAPABILITY_MAX_AGE is refused as expired, whatever its own `exp` says.
    return new CapabilityTokenError(err.claim === "iat" ? "expired" : "bad-claims", message);
  }
  return new CapabilityTokenError("malformed", message);
}

/** Checks the claims this service relies on, beyond what `jwtVerify` checks. */
function toCapability(payload: JWTPayload): Capability {
  const fail = (detail: string) => new CapabilityTokenError("bad-claims", detail);

  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 128) {
    throw fail("sub must be a non-empty string of at most 128 characters");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 128) {
    throw fail("jti must be a non-empty string of at most 128 characters");
  }

  const act = (payload as { act?: unknown }).act;
  if (!Array.isArray(act) || act.length === 0) throw fail("act must be a non-empty array");
  const actions = new Set<CapabilityAction>();
  for (const a of act) {
    if (!(CAPABILITY_ACTIONS as readonly unknown[]).includes(a)) {
      throw fail(`act contains an unknown action: ${JSON.stringify(a)}`);
    }
    actions.add(a as CapabilityAction);
  }

  // Content ids are Studio's integers, carried as strings everywhere in
  // Lumi. Accept either form and normalise, but nothing else: a cid like
  // "12 " or "1e3" must not match content 12 or 1000.
  const rawCid = (payload as { cid?: unknown }).cid;
  let contentId: string | undefined;
  if (rawCid !== undefined) {
    const asString = typeof rawCid === "number" ? String(rawCid) : rawCid;
    if (typeof asString !== "string" || !/^[1-9]\d{0,15}$/.test(asString)) {
      throw fail("cid must be a positive integer content id");
    }
    contentId = asString;
  }
  for (const a of ACTIONS_NEEDING_CID) {
    if (actions.has(a) && !contentId) throw fail(`act "${a}" needs a cid`);
  }

  return {
    subject,
    contentId,
    actions,
    tokenId: payload.jti,
    expiresAt: new Date((payload.exp as number) * 1000),
  };
}
