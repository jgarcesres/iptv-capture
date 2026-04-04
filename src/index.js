import Fastify from "fastify";
import { captureAll } from "./capture.js";
import { getChannels } from "./channels.js";

const PORT = parseInt(process.env.PORT || "8080");
const REFRESH_INTERVAL_MS = parseInt(
  process.env.REFRESH_INTERVAL_MS || "1200000"
); // 20 minutes
const STALE_THRESHOLD_MS = parseInt(
  process.env.STALE_THRESHOLD_MS || "3600000"
); // 1 hour

/** @type {Map<string, {url: string, capturedAt: number}>} */
const streamCache = new Map();
let lastCaptureRun = 0;
let captureInProgress = false;

async function runCapture() {
  if (captureInProgress) return;
  captureInProgress = true;

  const channels = getChannels();
  console.log(
    `[capture] Starting capture for ${channels.length} channel(s)...`
  );

  try {
    const results = await captureAll(channels);
    for (const [id, url] of Object.entries(results)) {
      if (url) {
        streamCache.set(id, { url, capturedAt: Date.now() });
        console.log(`[capture] ${id}: captured stream URL`);
      } else {
        console.warn(`[capture] ${id}: failed to capture`);
      }
    }
    lastCaptureRun = Date.now();
  } catch (err) {
    console.error("[capture] Fatal error:", err.message);
  } finally {
    captureInProgress = false;
  }
}

const app = Fastify({ logger: false });

app.get("/playlist.m3u", async (_req, reply) => {
  // Trigger on-demand refresh if cache is stale
  if (Date.now() - lastCaptureRun > STALE_THRESHOLD_MS) {
    await runCapture();
  }

  const channels = getChannels();
  let m3u = "#EXTM3U\n";

  for (const ch of channels) {
    const cached = streamCache.get(ch.id);
    if (!cached) continue;

    m3u += `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo || ""}",${ch.name}\n`;
    m3u += `${cached.url}\n`;
  }

  reply.type("audio/x-mpegurl").send(m3u);
});

app.get("/health", async (_req, reply) => {
  const channels = getChannels();
  const cached = channels.filter((ch) => streamCache.has(ch.id));
  const healthy = cached.length > 0 || Date.now() - lastCaptureRun < 120000;

  reply.code(healthy ? 200 : 503).send({
    status: healthy ? "ok" : "unhealthy",
    channels: channels.length,
    captured: cached.length,
    lastCapture: lastCaptureRun ? new Date(lastCaptureRun).toISOString() : null,
    captureInProgress,
  });
});

app.get("/status", async (_req, reply) => {
  const channels = getChannels();
  const status = channels.map((ch) => {
    const cached = streamCache.get(ch.id);
    return {
      id: ch.id,
      name: ch.name,
      captured: !!cached,
      capturedAt: cached ? new Date(cached.capturedAt).toISOString() : null,
      ageMinutes: cached
        ? Math.round((Date.now() - cached.capturedAt) / 60000)
        : null,
    };
  });

  reply.send({ channels: status, lastCapture: lastCaptureRun ? new Date(lastCaptureRun).toISOString() : null });
});

async function main() {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[server] Listening on port ${PORT}`);

  // Initial capture
  runCapture();

  // Schedule periodic refresh
  setInterval(runCapture, REFRESH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
