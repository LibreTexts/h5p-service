import { pino } from "pino";

/**
 * Single logging entry point, matching Conductor's convention: bindings object
 * first, human-readable message last, errors always under `err` so the stack
 * survives.
 *
 *   logger.info({ contentId }, "Served embed");
 *   logger.error({ err }, "Failed to render embed");
 */
/**
 * Reads LOG_LEVEL directly rather than importing `config`.
 *
 * Config validation throws on missing variables, so importing it here would
 * mean any module that logs cannot be loaded without a full environment. That
 * makes storage and utility classes untestable in isolation.
 *
 * `config.ts` validates LOG_LEVEL against pino's levels and is imported first
 * by the entrypoint, so the service reports a bad level there. A module loaded
 * on its own gets pino's own error instead. This is the one deliberate
 * exception to reading configuration only through `config.ts`.
 */
const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: "h5p-service" },
});

/**
 * Tags a subsystem with a queryable `component` field rather than a string
 * prefix in the message.
 */
export function childLogger(component: string) {
  return logger.child({ component });
}

export default logger;
