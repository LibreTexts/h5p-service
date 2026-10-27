/**
 * Loads migrated activities in a real browser, the way a textbook page does,
 * and reports which ones break. READ-ONLY: it only requests embed pages.
 *
 * This is the automated half of the Phase 3 compatibility gate in the
 * migration runbook. It tells a person where to look; it does not replace
 * someone using each content type. For every sampled activity it frames
 * `/h5p/{id}/embed` in a cross-origin parent page that loads the H5P resizer
 * exactly as published textbooks do, then checks:
 *
 *   errors     no uncaught exception or unhandled rejection in any frame, and
 *              no console error (h5peditor's cross-origin `window.parent` read
 *              surfaced as a page error only, so both are watched)
 *   network    no 4xx/5xx or failed request to the service itself; third-party
 *              failures (YouTube, fonts) are listed but do not fail the run
 *   render     the content type initialised and drew something
 *   resizer    the hello / prepareResize / resize handshake completed and the
 *              parent's resizer set the iframe's height
 *
 *   npx tsx --env-file=.env src/migrations/sweepEmbeds.ts \
 *     --base-url=https://staging-h5p.libretexts.org \
 *     [--sample=150 | --ids=101,102] [--concurrency=4] [--timeout=30000] [--headed]
 *
 * The sample takes every content type at least once, then spends the rest in
 * proportion to how often each type is used, spread evenly across each type's
 * id range. Deterministic, so a re-run after a fix loads the same activities.
 *
 * The parent page is served by request interception at
 * `https://embed-sweep.libretexts.org/`, because `EMBED_FRAME_ANCESTORS` only
 * admits LibreTexts origins. Nothing is ever requested from that host.
 *
 * Needs `MONGODB_*` (to sample) and Chromium for playwright-core:
 * `npx playwright-core install chromium-headless-shell` once.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright-core";
import config from "../config.js";
import logger, { childLogger } from "../logger.js";

const log = childLogger("embed-sweep");

const DEFAULT_SAMPLE = 150;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
/** After rendering, how long to keep listening for late errors and resizes. */
const SETTLE_MS = 2_500;
const PARENT_URL = "https://embed-sweep.libretexts.org/";
const PRINT_LIMIT = 20;

/**
 * Problems the sweep reports without failing on, because Studio had them too:
 * the same pinned library code, or the same embed code, produced them there.
 * Add to this only with that evidence. Anything else is a regression.
 */
const KNOWN: { pattern: RegExp; reason: string }[] = [
  {
    // MemoryGame and ImageHotspotQuestion assign an unset image src, which
    // resolves against the embed page. Nothing visible is missing.
    pattern: /^404 \S+\/h5p\/\d+\/undefined$/,
    reason: "content type requests 'undefined'",
  },
  {
    // Studio's embed code never granted the camera, so AR content could not
    // use it inside a textbook either.
    pattern: /Permissions policy violation: camera is not allowed/,
    reason: "embed code does not grant the camera",
  },
];

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function positiveInt(name: string, fallback: number): number {
  const v = argValue(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name}= takes a positive integer.`);
  return n;
}

function parseIds(): number[] {
  const v = argValue("ids");
  if (!v) return [];
  return v.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--ids= has an invalid content id: "${s}".`);
    return n;
  });
}

type Target = { id: number; library: string };

type Result = Target & {
  ok: boolean;
  rendered: boolean;
  resized: boolean;
  handshake: string[];
  iframeHeight: number;
  errors: string[];
  consoleErrors: string[];
  serviceFailures: string[];
  thirdPartyFailures: string[];
  known: string[];
  ms: number;
};

/**
 * Every content type at least once, the remainder by share of usage, ids
 * spread evenly within each type.
 */
async function sampleTargets(sample: number, ids: number[]): Promise<{ targets: Target[]; usage: Record<string, number> }> {
  const mongo = new MongoClient(config.mongo.url, { serverSelectionTimeoutMS: 15_000 });
  await mongo.connect();
  try {
    const content = mongo.db(config.mongo.db).collection(config.mongo.contentCollection);
    if (ids.length) {
      const docs = await content
        // Content ids are stored as strings (IntegerIdContentStorage).
        .find({ _id: { $in: ids.map(String) as any[] } }, { projection: { "metadata.mainLibrary": 1 } })
        .toArray();
      const lib = new Map(docs.map((d: any) => [Number(d._id), d.metadata?.mainLibrary ?? ""]));
      return { targets: ids.map((id) => ({ id, library: lib.get(id) ?? "(not in Mongo)" })), usage: {} };
    }

    // Grouped in the database: pulling every record to group here took
    // minutes against a remote cluster.
    const groups = await content
      .aggregate<{ _id: string | null; ids: unknown[] }>(
        [{ $group: { _id: "$metadata.mainLibrary", ids: { $push: "$_id" } } }],
        { allowDiskUse: true }
      )
      .toArray();
    const byLibrary = new Map<string, number[]>(
      groups.map((g) => [g._id ?? "", g.ids.map(Number).filter(Number.isInteger).sort((a, b) => a - b)])
    );
    const total = [...byLibrary.values()].reduce((n, l) => n + l.length, 0);
    const usage = Object.fromEntries([...byLibrary].map(([l, a]) => [l, a.length]).sort((a, b) => (b[1] as number) - (a[1] as number)));

    const remaining = Math.max(0, sample - byLibrary.size);
    const targets: Target[] = [];
    for (const [library, all] of byLibrary) {
      const n = Math.min(all.length, 1 + Math.round((remaining * all.length) / Math.max(1, total)));
      for (let i = 0; i < n; i++) {
        targets.push({ id: all[Math.floor(((i + 0.5) * all.length) / n)], library });
      }
    }
    return { targets, usage };
  } finally {
    await mongo.close();
  }
}

function parentPage(base: string, id: number): string {
  // The resizer is loaded after the iframe, as Studio's embed code placed it.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed sweep ${id}</title></head><body>
<script>
window.__sweepMessages = [];
window.addEventListener("message", function (e) {
  if (e.origin === ${JSON.stringify(base)} && e.data && e.data.context === "h5p") window.__sweepMessages.push(e.data.action);
});
</script>
<iframe id="activity" src="${base}/h5p/${id}/embed" width="1000" height="150" frameborder="0" allowfullscreen="allowfullscreen" title="Activity ${id}"></iframe>
<script src="${base}/h5p/core/js/h5p-resizer.js" charset="UTF-8"></script>
</body></html>`;
}

/** Runs in every frame, cross-origin ones included, before any page script. */
const CAPTURE_ERRORS = `(() => {
  window.__sweepErrors = [];
  window.addEventListener("error", (e) => {
    window.__sweepErrors.push((e.error && e.error.stack ? e.error.stack.split("\\n").slice(0, 2).join(" | ") : e.message) + " @ " + (e.filename || "") + ":" + (e.lineno || ""));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    window.__sweepErrors.push("unhandled rejection: " + (r && r.message ? r.message : String(r)));
  });
})();`;

async function sweepOne(browser: Browser, base: string, target: Target, timeout: number): Promise<Result> {
  const started = Date.now();
  const result: Result = {
    ...target, ok: false, rendered: false, resized: false, handshake: [], iframeHeight: 0,
    errors: [], consoleErrors: [], serviceFailures: [], thirdPartyFailures: [], known: [], ms: 0,
  };
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(CAPTURE_ERRORS);
  await context.route(PARENT_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: parentPage(base, target.id) })
  );
  const page: Page = await context.newPage();
  const fromService = (url: string) => url.startsWith(base + "/");

  page.on("pageerror", (err) => result.errors.push(`${err.name}: ${err.message}`));
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const where = msg.location()?.url ?? "";
    // Browsers echo failed requests to the console; the network listeners
    // already classify those, so count only script-level errors here.
    if (/^Failed to load resource/.test(msg.text())) return;
    result.consoleErrors.push(`${msg.text().slice(0, 300)}${where ? ` @ ${where}` : ""}`);
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const entry = `${res.status()} ${res.url()}`;
    (fromService(res.url()) ? result.serviceFailures : result.thirdPartyFailures).push(entry);
  });
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "failed";
    // Navigations the page itself aborts (a video player swapping sources)
    // are not failures.
    if (reason === "net::ERR_ABORTED") return;
    const entry = `${reason} ${req.url()}`;
    (fromService(req.url()) ? result.serviceFailures : result.thirdPartyFailures).push(entry);
  });

  try {
    await page.goto(PARENT_URL, { waitUntil: "load", timeout });
    const frame = page.frameLocator("#activity");
    const content = frame.locator(".h5p-content.h5p-initialized").first();
    try {
      await content.waitFor({ state: "attached", timeout });
      // H5P marks the container before the content type draws into it, and
      // image-led types stay short until their image loads, so poll.
      const deadline = Date.now() + Math.min(timeout, 10_000);
      while (!result.rendered && Date.now() < deadline) {
        result.rendered = await content.evaluate(
          (el) => el.childElementCount > 0 && el.getBoundingClientRect().height > 40,
          undefined,
          { timeout: 5_000 }
        );
        if (!result.rendered) await page.waitForTimeout(250);
      }
    } catch {
      result.rendered = false;
    }
    await page.waitForTimeout(SETTLE_MS);

    // Strings, not functions: this repo compiles without DOM types.
    result.handshake = (await page.evaluate("window.__sweepMessages")) as string[];
    result.iframeHeight = (await page.evaluate(
      "parseInt(document.getElementById('activity').style.height || '0', 10) || 0"
    )) as number;
    result.resized = result.handshake.includes("resize") && result.iframeHeight > 0;

    for (const f of page.frames()) {
      const errs = ((await f.evaluate("window.__sweepErrors || []").catch(() => [])) as string[]);
      for (const e of errs) if (!result.errors.some((x) => e.includes(x.split(": ").slice(1).join(": ").slice(0, 60)))) result.errors.push(e);
    }
  } catch (err) {
    result.errors.push(`sweep: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await context.close();
  }

  // Set known, pre-existing problems aside so they neither fail the run nor
  // hide among the new ones.
  for (const list of [result.consoleErrors, result.serviceFailures]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const known = KNOWN.find((k) => k.pattern.test(list[i]));
      if (known) result.known.push(`${known.reason}: ${list.splice(i, 1)[0]}`);
    }
  }
  result.ok =
    result.rendered && result.resized && !result.errors.length && !result.consoleErrors.length && !result.serviceFailures.length;
  result.ms = Date.now() - started;
  return result;
}

async function run(): Promise<boolean> {
  const baseArg = argValue("base-url");
  if (!baseArg) throw new Error("--base-url= is required: the h5p-service origin to sweep.");
  const base = new URL(baseArg).origin;
  const sample = positiveInt("sample", DEFAULT_SAMPLE);
  const concurrency = positiveInt("concurrency", DEFAULT_CONCURRENCY);
  const timeout = positiveInt("timeout", DEFAULT_TIMEOUT_MS);

  const { targets, usage } = await sampleTargets(sample, parseIds());
  log.info({ base, activities: targets.length, contentTypes: new Set(targets.map((t) => t.library)).size }, "Sweeping embeds");

  // Chrome's Local Network Access check stops a public origin, like the
  // parent page, from framing localhost. Textbooks frame a public host, so
  // lift it only for a local run.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname);
  const browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    args: loopback ? ["--disable-features=LocalNetworkAccessChecks"] : [],
  });
  const results: Result[] = [];
  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
        while (next < targets.length) {
          const target = targets[next++];
          const r = await sweepOne(browser, base, target, timeout);
          results.push(r);
          log.debug({ id: r.id, library: r.library, ok: r.ok, ms: r.ms }, "Swept");
          if (results.length % 25 === 0) log.info({ done: results.length, of: targets.length }, "Progress");
        }
      })
    );
  } finally {
    await browser.close();
  }
  results.sort((a, b) => a.library.localeCompare(b.library) || a.id - b.id);

  const byLibrary: Record<string, { swept: number; failed: number; usage: number; failures: Record<string, number> }> = {};
  for (const r of results) {
    const s = (byLibrary[r.library] ??= { swept: 0, failed: 0, usage: usage[r.library] ?? 0, failures: {} });
    s.swept++;
    if (r.ok) continue;
    s.failed++;
    const reasons = [
      !r.rendered && "not rendered",
      !r.resized && "resizer",
      r.errors.length && "uncaught errors",
      r.consoleErrors.length && "console errors",
      r.serviceFailures.length && "service requests failed",
    ].filter(Boolean) as string[];
    for (const reason of reasons) s.failures[reason] = (s.failures[reason] ?? 0) + 1;
  }
  const failed = results.filter((r) => !r.ok);

  // The same error across many activities is one bug; group them so the
  // report leads with what to fix.
  const signatures: Record<string, { count: number; libraries: string[]; example: number }> = {};
  for (const r of failed) {
    for (const e of [...r.errors, ...r.consoleErrors, ...r.serviceFailures.map((f) => f.replace(/\/h5p\/(content\/)?\d+\//, "/h5p/$1{id}/"))]) {
      const sig = e
        .replace(/\/(images|videos|audios|files)\/[^/?\s]+/g, "/$1/{file}")
        .replace(/\d{3,}/g, "N")
        .replace(/:\d+(:\d+)?/g, "")
        .slice(0, 160);
      const s = (signatures[sig] ??= { count: 0, libraries: [], example: r.id });
      s.count++;
      if (!s.libraries.includes(r.library)) s.libraries.push(r.library);
    }
  }
  const topSignatures = Object.entries(signatures).sort((a, b) => b[1].count - a[1].count);

  const report = {
    base,
    at: new Date().toISOString(),
    swept: results.length,
    failed: failed.length,
    byLibrary,
    signatures: Object.fromEntries(topSignatures),
    results,
  };
  const outDir = path.resolve("migration-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outDir, `h5p-embed-sweep-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const failingTypes = Object.entries(byLibrary).filter(([, s]) => s.failed).sort((a, b) => b[1].usage - a[1].usage);
  process.stdout.write(
    `\nEmbed sweep of ${base}\n` +
      `  activities swept:   ${results.length} across ${Object.keys(byLibrary).length} content types\n` +
      `  passed:             ${results.length - failed.length}\n` +
      `  failed:             ${failed.length}\n` +
      `  known issues seen:  ${results.reduce((n, r) => n + r.known.length, 0)} (listed in the report, not failures)\n` +
      (failingTypes.length
        ? `\n  Failing content types, most used first (failed/swept, usage):\n` +
          failingTypes
            .slice(0, PRINT_LIMIT)
            .map(([l, s]) => `    ${l || "(no main library)"}  ${s.failed}/${s.swept}  (${s.usage})  ${Object.entries(s.failures).map(([k, v]) => `${k} ${v}`).join(", ")}`)
            .join("\n") +
          "\n"
        : "") +
      (topSignatures.length
        ? `\n  Most common problems:\n` +
          topSignatures
            .slice(0, PRINT_LIMIT)
            .map(([sig, s]) => `    ${s.count}x  ${sig}\n          e.g. /h5p/${s.example}/embed, in ${s.libraries.slice(0, 4).join(", ")}${s.libraries.length > 4 ? ", ..." : ""}`)
            .join("\n") +
          "\n"
        : "") +
      `\nReport: ${reportPath}\n`
  );
  return failed.length === 0;
}

run()
  .then((ok) => {
    // No process.exit(): let the browser and Mongo sockets close on their own.
    if (!ok) process.exitCode = 1;
  })
  .catch((err) => {
    logger.fatal({ err }, "Embed sweep failed");
    process.exitCode = 1;
  });
