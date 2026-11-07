import config from "./config.js";
import logger from "./logger.js";
import { buildH5P, keepContentTypeCacheWarm } from "./h5p.js";
import { createApp } from "./app.js";
import { InFlightRequests } from "./observability/requestLog.js";
import { startPoolGauge } from "./observability/poolGauge.js";

async function main(): Promise<void> {
  const stack = await buildH5P();
  const inFlight = new InFlightRequests();
  const app = createApp(stack, inFlight);
  // Started here rather than in buildH5P, which the Studio import also calls.
  startPoolGauge(stack.pools, inFlight, { reportMs: config.observability.poolReportMs });
  // Only the editor reads the content type cache, so the Hub is never
  // contacted while authoring is off.
  if (config.authoring.enabled) keepContentTypeCacheWarm(stack);
  app.listen(config.port, () => {
    logger.info(
      { port: config.port, baseUrl: config.baseUrl, env: config.nodeEnv },
      "h5p-service listening"
    );
  });
}

main().catch((err) => {
  logger.fatal({ err }, "h5p-service failed to start");
  process.exit(1);
});
