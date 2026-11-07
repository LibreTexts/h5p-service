import { childLogger } from "../logger.js";
import type { InFlightRequests } from "./requestLog.js";
import type { S3Pool } from "./s3Pool.js";

const log = childLogger("s3-pool");

/** How often the pools are sampled between reports, so a short spike is not missed. */
const SAMPLE_MS = 5_000;

/**
 * Reports every S3 pool and the requests in flight each `reportMs`.
 *
 * Each report carries the counts at that moment and the peaks seen since the
 * last one. It is a warning whenever any origin had a request queued, which
 * means that origin's sockets were all held. Timers are unref'd, so the gauge
 * never keeps a process alive.
 */
export function startPoolGauge(pools: S3Pool[], inFlight: InFlightRequests, { reportMs }: { reportMs: number }): void {
  const peaks = new Map<string, { inUse: number; queued: number }>();

  const sample = () => {
    for (const pool of pools) {
      for (const [origin, s] of Object.entries(pool.stats().origins)) {
        const key = `${pool.name} ${origin}`;
        const peak = peaks.get(key) ?? { inUse: 0, queued: 0 };
        peak.inUse = Math.max(peak.inUse, s.inUse);
        peak.queued = Math.max(peak.queued, s.queued);
        peaks.set(key, peak);
      }
    }
  };

  const report = () => {
    sample();
    const now: Record<string, unknown> = {};
    for (const pool of pools) now[pool.name] = pool.stats().origins;
    const peak = Object.fromEntries(peaks);
    const saturated = [...peaks.values()].some((p) => p.queued > 0);
    const fields = { pools: now, peak, inFlight: inFlight.summary(), reportMs };
    if (saturated) log.warn(fields, "S3 pool saturated");
    else log.info(fields, "S3 pool usage");
    peaks.clear();
  };

  setInterval(sample, SAMPLE_MS).unref();
  setInterval(report, reportMs).unref();
}
