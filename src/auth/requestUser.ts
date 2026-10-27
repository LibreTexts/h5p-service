import type { NextFunction, Request, Response } from "express";
import { anonymousUser } from "../h5p.js";
import { childLogger } from "../logger.js";
import type { CapabilityUser } from "./CapabilityPermissionSystem.js";
import { CapabilityTokenError, type CapabilityVerifier } from "./capabilityToken.js";

const log = childLogger("capability");

/**
 * Sets `req.user` for Lumi's routes.
 *
 * No Authorization header: the anonymous user, exactly as in phase 1, so
 * embeds, parameters, files and downloads behave as before. A Bearer token
 * that verifies: a user carrying that token's capability. Anything else gets
 * a 401 rather than falling back to anonymous, so a broken token is visible
 * to the editor instead of turning into a confusing 403 three calls later.
 *
 * The rejection reason is logged and never returned, so a caller probing with
 * forged tokens learns nothing about why they failed.
 */
export function capabilityUserMiddleware(verify: CapabilityVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header) {
      (req as any).user = anonymousUser();
      next();
      return;
    }

    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    if (!match) {
      log.warn({ path: req.path, reason: "malformed" }, "Rejected authorization header");
      res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
      return;
    }

    try {
      const capability = await verify(match[1]);
      const user: CapabilityUser = {
        id: capability.subject,
        name: capability.subject,
        email: "",
        type: "local",
        capability,
      };
      (req as any).user = user;
      log.debug(
        { path: req.path, sub: capability.subject, cid: capability.contentId, jti: capability.tokenId },
        "Capability accepted"
      );
      next();
    } catch (err) {
      const reason = err instanceof CapabilityTokenError ? err.reason : "malformed";
      log.warn({ path: req.path, reason, err }, "Rejected capability token");
      res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
    }
  };
}
