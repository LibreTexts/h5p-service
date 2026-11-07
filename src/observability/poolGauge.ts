import { childLogger } from "../logger.js";
import type { InFlightRequests } from "./requestLog.js";
import type { S3Pool } from "./s3Pool.js";

const log = childLogger("s3-pool");

/** How often the pools are sampled between reports, so a short spike is not missed. */
const SAMPLE_MS = 5_000;

/**
 * Samples every S3 pool, reports them each `reportMs`, and says when one has
 * been stuck long enough that the task should be replaced.
 *
 * Each report carries the counts at that moment and the peaks seen since the
 * last one. It is a warning whenever any origin had a request queued, which
 * means that origin's sockets were all held.
 *
 * A pool counts as stuck while it has requests queued at every sample. With
 * request timeouts on, a burst drains within one timeout, so a queue that
 * lasts `unhealthyAfterMs` means sockets are held and only a restart frees
 * them. That is the state that left /health green while every upload failed.
 */
export class PoolMonitor {
  private peaks = new Map<string, { inUse: number; queued: number }>();
  /** When each pool origin was first seen with a queue, until it empties. */
  private queuedSince = new Map<string, number>();

  constructor(
    private pools: S3Pool[],
    private inFlight: InFlightRequests,
    private options: { reportMs: number; unhealthyAfterMs: number }
  ) {}

  /** Timers are unref'd, so the monitor never keeps a process alive. */
  start(): void {
    setInterval(() => this.sample(), SAMPLE_MS).unref();
    setInterval(() => this.report(), this.options.reportMs).unref();
  }

  /** Pool origins stuck for at least `unhealthyAfterMs`, with how long. */
  stuck(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [key, since] of this.queuedSince) {
      if (now - since >= this.options.unhealthyAfterMs) out[key] = now - since;
    }
    return out;
  }

  private sample(): void {
    const now = Date.now();
    const queuedNow = new Set<string>();
    for (const pool of this.pools) {
      for (const [origin, s] of Object.entries(pool.stats().origins)) {
        const key = `${pool.name} ${origin}`;
        const peak = this.peaks.get(key) ?? { inUse: 0, queued: 0 };
        peak.inUse = Math.max(peak.inUse, s.inUse);
        peak.queued = Math.max(peak.queued, s.queued);
        this.peaks.set(key, peak);
        if (s.queued > 0) queuedNow.add(key);
      }
    }
    for (const key of queuedNow) if (!this.queuedSince.has(key)) this.queuedSince.set(key, now);
    for (const key of [...this.queuedSince.keys()]) if (!queuedNow.has(key)) this.queuedSince.delete(key);
  }

  private report(): void {
    this.sample();
    const now: Record<string, unknown> = {};
    for (const pool of this.pools) now[pool.name] = pool.stats().origins;
    const peak = Object.fromEntries(this.peaks);
    const saturated = [...this.peaks.values()].some((p) => p.queued > 0);
    const stuck = this.stuck();
    const fields = { pools: now, peak, stuck, inFlight: this.inFlight.summary(), reportMs: this.options.reportMs };
    if (Object.keys(stuck).length) log.error(fields, "S3 pool stuck; /health is failing");
    else if (saturated) log.warn(fields, "S3 pool saturated");
    else log.info(fields, "S3 pool usage");
    this.peaks.clear();
  }
}
