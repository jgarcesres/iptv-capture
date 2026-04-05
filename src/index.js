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

/**
 * M3U playlist — points to local proxy URLs instead of external CDNs.
 */
app.get("/playlist.m3u", async (req, reply) => {
  if (Date.now() - lastCaptureRun > STALE_THRESHOLD_MS) {
    await runCapture();
  }

  const channels = getChannels();
  const baseUrl = `http://${req.headers.host}`;
  let m3u = "#EXTM3U\n";

  for (const ch of channels) {
    const cached = streamCache.get(ch.id);
    if (!cached) continue;

    m3u += `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo || ""}",${ch.name}\n`;
    m3u += `${baseUrl}/stream/${ch.id}/playlist.m3u8\n`;
  }

  reply.type("audio/x-mpegurl").send(m3u);
});

/**
 * HLS proxy — master playlist.
 * Fetches the upstream HLS manifest, follows redirects, and rewrites
 * all URLs so sub-playlists and segments also go through our proxy.
 */
app.get("/stream/:channelId/playlist.m3u8", async (req, reply) => {
  const { channelId } = req.params;
  const cached = streamCache.get(channelId);
  if (!cached) {
    return reply.code(404).send({ error: "Channel not found or not captured" });
  }

  try {
    const resp = await fetch(cached.url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) {
      return reply
        .code(502)
        .send({ error: `Upstream returned ${resp.status}` });
    }

    const upstreamUrl = resp.url; // final URL after redirects
    const body = await resp.text();
    const baseUrl = `http://${req.headers.host}`;
    const rewritten = rewriteManifest(body, upstreamUrl, baseUrl, channelId);

    reply
      .type("application/vnd.apple.mpegurl")
      .header("Cache-Control", "no-cache")
      .send(rewritten);
  } catch (err) {
    console.error(`[proxy] ${channelId}: master playlist error - ${err.message}`);
    reply.code(502).send({ error: err.message });
  }
});

/**
 * HLS proxy — sub-playlists and segments.
 * The URL to fetch is base64-encoded in the path to avoid routing issues.
 */
app.get("/stream/:channelId/seg", async (req, reply) => {
  const { channelId } = req.params;
  const encodedUrl = req.query.u;
  if (!encodedUrl) {
    return reply.code(400).send({ error: "Missing u query parameter" });
  }
  const url = Buffer.from(encodedUrl, "base64url").toString();

  try {
    const resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) {
      return reply
        .code(502)
        .send({ error: `Upstream returned ${resp.status}` });
    }

    const contentType = resp.headers.get("content-type") || "";

    // If this is a sub-playlist (m3u8), rewrite its URLs too
    if (contentType.includes("mpegurl") || url.endsWith(".m3u8")) {
      const body = await resp.text();
      const baseUrl = `http://${req.headers.host}`;
      const rewritten = rewriteManifest(body, url, baseUrl, channelId);
      return reply
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache")
        .send(rewritten);
    }

    // Binary segment — pipe through
    reply
      .type(contentType || "video/mp2t")
      .header("Cache-Control", "no-cache");
    const buffer = Buffer.from(await resp.arrayBuffer());
    return reply.send(buffer);
  } catch (err) {
    console.error(`[proxy] ${channelId}: segment error - ${err.message}`);
    reply.code(502).send({ error: err.message });
  }
});

/**
 * Rewrite URLs in an HLS manifest so they route through our proxy.
 * Handles both absolute and relative URLs.
 */
function rewriteManifest(manifest, manifestUrl, baseUrl, channelId) {
  const manifestBase = manifestUrl.substring(
    0,
    manifestUrl.lastIndexOf("/") + 1
  );

  return manifest
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Skip empty lines, comments, and tags (except URI= attributes)
      if (!trimmed || trimmed.startsWith("#")) {
        // Rewrite URI="..." attributes in tags like #EXT-X-MEDIA
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => {
          const absUrl = resolveUrl(uri, manifestBase);
          const encoded = Buffer.from(absUrl).toString("base64url");
          return `URI="${baseUrl}/stream/${channelId}/seg?u=${encoded}"`;
        });
      }
      // This is a URL line — rewrite it
      const absUrl = resolveUrl(trimmed, manifestBase);
      const encoded = Buffer.from(absUrl).toString("base64url");
      return `${baseUrl}/stream/${channelId}/seg?u=${encoded}`;
    })
    .join("\n");
}

/**
 * Resolve a potentially relative URL against a base.
 */
function resolveUrl(url, base) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return new URL(url, base).toString();
}

app.get("/health", async (_req, reply) => {
  const channels = getChannels();
  const cached = channels.filter((ch) => streamCache.has(ch.id));
  const healthy = cached.length > 0 || Date.now() - lastCaptureRun < 120000;

  reply.code(healthy ? 200 : 503).send({
    status: healthy ? "ok" : "unhealthy",
    channels: channels.length,
    captured: cached.length,
    lastCapture: lastCaptureRun
      ? new Date(lastCaptureRun).toISOString()
      : null,
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

  reply.send({
    channels: status,
    lastCapture: lastCaptureRun
      ? new Date(lastCaptureRun).toISOString()
      : null,
  });
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
