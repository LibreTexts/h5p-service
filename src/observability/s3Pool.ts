import http from "node:http";
import https from "node:https";
import { childLogger } from "../logger.js";

/**
 * The SDK's own defaults, restated. Handing the SDK our agents is what lets
 * the service read its pools, and it must not change their size or reuse.
 */
const KEEP_ALIVE = true;
const MAX_SOCKETS = 50;

/** How long opening a connection to S3 may take. */
const CONNECTION_TIMEOUT_MS = 5_000;

export interface OriginStats {
  /** Sockets carrying a request or holding an unread response body. */
  inUse: number;
  /** Requests waiting for a socket. Above zero only when `inUse` is at the limit. */
  queued: number;
  /** Idle keep-alive sockets. */
  free: number;
}

/**
 * Socket counts for one S3 client, per origin.
 *
 * Node's `maxSockets` applies to each origin separately, and with
 * virtual-hosted S3 addressing every bucket is its own origin. A full pool is
 * therefore a full bucket host, and which bucket says which traffic filled it.
 */
export interface S3PoolStats {
  maxSocketsPerOrigin: number;
  origins: Record<string, OriginStats>;
}

/**
 * The socket pool behind one S3 client.
 *
 * The SDK's own warning about a full pool goes to `console` and does not say
 * which client it means. Routing it through pino tagged with the pool name,
 * and sampling the pool ourselves, makes a stuck client identifiable from the
 * logs alone.
 */
export class S3Pool {
  readonly httpAgent = new http.Agent({ keepAlive: KEEP_ALIVE, maxSockets: MAX_SOCKETS });
  readonly httpsAgent = new https.Agent({ keepAlive: KEEP_ALIVE, maxSockets: MAX_SOCKETS });

  /**
   * @param buckets bucket name to role ("content", "library", "temporary"), so
   * origins are reported by role. Bucket host names stay out of the logs and
   * out of /health, which is public.
   */
  constructor(
    readonly name: string,
    private buckets: Record<string, string> = {},
    private requestTimeoutMs?: number
  ) {}

  /**
   * For the `requestHandler` option of an S3 client.
   *
   * The request timeout runs from the moment a request is made until its
   * response headers arrive, time spent queued for a socket included, and
   * `throwOnRequestTimeout` makes it fail the request rather than only warn.
   * Without it a request queued behind a full pool waited forever, and the
   * queue reached 5,509 in production. A response body is not covered: once
   * headers arrive the caller owns the stream, and the routes that stream
   * bodies run their own idle timers.
   */
  requestHandler() {
    return {
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: this.requestTimeoutMs,
      throwOnRequestTimeout: this.requestTimeoutMs !== undefined,
      logger: childLogger("s3").child({ pool: this.name }),
    };
  }

  stats(): S3PoolStats {
    const origins: Record<string, OriginStats> = {};
    const tally = (map: NodeJS.ReadOnlyDict<unknown[]>, field: keyof OriginStats) => {
      for (const [name, list] of Object.entries(map)) {
        if (!list?.length) continue;
        const origin = this.originOf(name);
        origins[origin] ??= { inUse: 0, queued: 0, free: 0 };
        origins[origin][field] += list.length;
      }
    };
    for (const agent of [this.httpAgent, this.httpsAgent]) {
      tally(agent.sockets, "inUse");
      tally(agent.requests, "queued");
      tally(agent.freeSockets, "free");
    }
    return { maxSocketsPerOrigin: MAX_SOCKETS, origins };
  }

  /**
   * Node names an agent's pools `host:port:localAddress:...`, with TLS options
   * appended for https. With virtual-hosted addressing the host starts with
   * the bucket name. A path-style endpoint, such as MinIO in development,
   * serves every bucket from one host, which is reported as "shared".
   */
  private originOf(agentName: string): string {
    const host = agentName.split(":")[0];
    for (const [bucket, role] of Object.entries(this.buckets)) {
      if (host.startsWith(`${bucket}.`)) return role;
    }
    return "shared";
  }
}

