/**
 * Who may read private content.
 *
 * Studio checked no access on reads, and published textbooks depend on that,
 * so public content stays open to anyone. Conductor marks an activity's
 * content private when its visibility is private (`setPrivate`), and with
 * `PRIVATE_CONTENT_ENFORCED` on, its embed, parameters and download then need
 * a capability token granting `view` or `edit` for that content id.
 *
 * Content files (`/h5p/content/{id}/*`) are not gated. Browsers load them
 * through `<img src>` and the like, which cannot carry a token, Cloudflare
 * caches them for a year, and checking each one would put a Mongo read on
 * every file request. Their names carry H5P's random suffix and are listed
 * only in the gated parameters, the same reasoning as temporary files
 * (H5P_AUTHORING_DESIGN.md section 8).
 *
 * A refusal looks exactly like missing content, so probing ids reveals
 * nothing about which private ones exist.
 */
import type { Request } from "express";
import { childLogger } from "../logger.js";
import type { CapabilityUser } from "./CapabilityPermissionSystem.js";
import { CapabilityTokenError, type Capability, type CapabilityVerifier } from "./capabilityToken.js";

const log = childLogger("private-content");

export type ReadGate = {
  /**
   * Whether this request may read `contentId`, whose private flag the caller
   * has already read (the embed route reads it with the display options).
   *
   * @param options.allowQueryToken accept a token in `?token=` as well as the
   * Authorization header. Only for the embed page, which loads in an iframe
   * and so cannot send a header.
   */
  allows(
    req: Request,
    contentId: string,
    isPrivate: boolean,
    options?: { allowQueryToken?: boolean }
  ): Promise<boolean>;
};

function grantsRead(capability: Capability | undefined, contentId: string): boolean {
  if (!capability || capability.contentId !== contentId) return false;
  return capability.actions.has("view") || capability.actions.has("edit");
}

/**
 * @param verify the capability verifier, absent when authoring is off. Config
 * refuses to enforce without it.
 */
export function createReadGate({
  enforced,
  verify,
}: {
  enforced: boolean;
  verify?: CapabilityVerifier;
}): ReadGate {
  return {
    async allows(req, contentId, isPrivate, { allowQueryToken = false } = {}) {
      if (!enforced || !isPrivate) return true;

      if (grantsRead(((req as any).user as CapabilityUser | undefined)?.capability, contentId)) return true;

      const token = req.query.token;
      if (allowQueryToken && verify && typeof token === "string" && token.length > 0) {
        try {
          const capability = await verify(token);
          if (grantsRead(capability, contentId)) {
            log.debug({ contentId, sub: capability.subject, jti: capability.tokenId }, "Private content opened");
            return true;
          }
          log.info({ contentId, cid: capability.contentId, jti: capability.tokenId }, "Token does not grant this content");
        } catch (err) {
          const reason = err instanceof CapabilityTokenError ? err.reason : "malformed";
          log.warn({ contentId, reason, err }, "Rejected capability token");
        }
      }
      return false;
    },
  };
}
