import Fastify from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureAll } from "./capture.js";
import { getChannels } from "./channels.js";
import {
  startDecryptPipeline,
  stopAll,
  isDecryptRunning,
  readDecryptedPlaylist,
  getDecryptedPlaylistPath,
  getHlsOutputDir,
} from "./decrypt.js";

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
    for (const [id, result] of Object.entries(results)) {
      if (!result) {
        console.warn(`[capture] ${id}: failed to capture`);
        continue;
      }

      // Result can be a string (URL) or an object with {url, dashUrl?, widevineLicenseUrl?}
      const isRich = typeof result === "object";
      const url = isRich ? result.url : result;
      const entry = { url, capturedAt: Date.now() };

      if (isRich && result.dashUrl) entry.dashUrl = result.dashUrl;
      if (isRich && result.widevineLicenseUrl) entry.widevineLicenseUrl = result.widevineLicenseUrl;

      streamCache.set(id, entry);
      console.log(`[capture] ${id}: captured stream URL${entry.dashUrl ? " + DASH URL" : ""}${entry.widevineLicenseUrl ? " + Widevine license" : ""}`);

      // Start decryption pipeline if we have DASH + Widevine license
      if (entry.dashUrl && entry.widevineLicenseUrl) {
        startDecryptPipeline(id, entry.dashUrl, entry.widevineLicenseUrl).catch((err) => {
          console.error(`[decrypt] ${id}: failed to start pipeline - ${err.message}`);
        });
      }
    }
    lastCaptureRun = Date.now();
  } catch (err) {
    console.error("[capture] Fatal error:", err.message);
  } finally {
    captureInProgress = false;
  }
}

const app = Fastify({ logger: false, maxParamLength: 2000 });

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

  // If we have a decrypted local stream, serve that instead
  const decryptedPlaylist = readDecryptedPlaylist(channelId);
  if (decryptedPlaylist) {
    // Rewrite segment paths to serve through our local file endpoint
    const baseUrl = `http://${req.headers.host}`;
    const rewritten = decryptedPlaylist.replace(
      /^(seg_\d+\.ts)$/gm,
      `${baseUrl}/stream/${channelId}/local/$1`
    );
    return reply
      .type("application/vnd.apple.mpegurl")
      .header("Cache-Control", "no-cache")
      .send(rewritten);
  }

  // Fallback: proxy the upstream (encrypted) stream
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
 * Serve local decrypted HLS segments from disk.
 */
app.get("/stream/:channelId/local/:filename", async (req, reply) => {
  const { channelId, filename } = req.params;

  // Sanitize filename to prevent path traversal
  if (filename.includes("/") || filename.includes("..")) {
    return reply.code(400).send({ error: "Invalid filename" });
  }

  const filePath = join(getHlsOutputDir(channelId), filename);
  if (!existsSync(filePath)) {
    return reply.code(404).send({ error: "Segment not found" });
  }

  const data = readFileSync(filePath);

  const contentType = filename.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp2t";

  reply
    .type(contentType)
    .header("Cache-Control", "no-cache")
    .send(data);
});

/**
 * HLS proxy — sub-playlists and segments.
 * URL scheme uses file extensions so ffmpeg's HLS demuxer accepts them:
 *   /stream/:channelId/s/<base64url>.ts   — segments
 *   /stream/:channelId/s/<base64url>.m3u8 — sub-playlists
 *   /stream/:channelId/s/<base64url>.mp4  — init segments
 */
app.get("/stream/:channelId/s/:encoded", async (req, reply) => {
  const { channelId } = req.params;
  // Strip the fake extension (.ts, .m3u8, .mp4) to get the base64url
  const encodedWithExt = req.params.encoded;
  const dotIdx = encodedWithExt.lastIndexOf(".");
  const encodedUrl = dotIdx >= 0 ? encodedWithExt.substring(0, dotIdx) : encodedWithExt;

  if (!encodedUrl) {
    return reply.code(400).send({ error: "Missing encoded URL" });
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
    const urlPath = url.split("?")[0];
    if (contentType.includes("mpegurl") || urlPath.endsWith(".m3u8")) {
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
    console.error(`[proxy] ${channelId}: segment error - ${err.message} | url: ${url.substring(0, 120)}`);
    reply.code(502).send({ error: err.message });
  }
});

/**
 * Infer a file extension for a URL to use in proxy paths.
 * This ensures ffmpeg's HLS demuxer recognizes the file type.
 */
function inferExtension(url) {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".m3u8")) return ".m3u8";
  if (path.endsWith(".mp4") || path.endsWith(".m4s") || path.endsWith(".m4v") || path.endsWith(".m4a")) return ".mp4";
  return ".ts";
}

/**
 * Rewrite URLs in an HLS manifest so they route through our proxy.
 * Handles both absolute and relative URLs.
 * Strips DRM key tags (skd://, FairPlay) since we can't proxy them.
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
      if (!trimmed) return trimmed;

      if (trimmed.startsWith("#")) {
        // Strip DRM key tags that use non-HTTP schemes (FairPlay skd://, etc.)
        if (trimmed.startsWith("#EXT-X-KEY:") && /URI="(?!https?:\/\/)/.test(trimmed)) {
          return null; // Remove this line
        }

        // Rewrite URI="..." attributes in tags like #EXT-X-MEDIA, #EXT-X-MAP
        return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => {
          // Skip non-HTTP schemes (skd://, data:, etc.) — can't be proxied
          if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith("http://") && !uri.startsWith("https://")) {
            return _match;
          }
          const absUrl = resolveUrl(uri, manifestBase);
          const ext = inferExtension(absUrl);
          const encoded = Buffer.from(absUrl).toString("base64url");
          return `URI="${baseUrl}/stream/${channelId}/s/${encoded}${ext}"`;
        });
      }

      // This is a URL line — rewrite it
      const absUrl = resolveUrl(trimmed, manifestBase);
      const ext = inferExtension(absUrl);
      const encoded = Buffer.from(absUrl).toString("base64url");
      return `${baseUrl}/stream/${channelId}/s/${encoded}${ext}`;
    })
    .filter((line) => line !== null)
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
      hasDash: !!cached?.dashUrl,
      hasWidevineLicense: !!cached?.widevineLicenseUrl,
      decryptRunning: isDecryptRunning(ch.id),
      decryptedPlaylist: !!getDecryptedPlaylistPath(ch.id),
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

// Graceful shutdown — stop ffmpeg processes
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[server] Received ${sig}, shutting down...`);
    stopAll();
    process.exit(0);
  });
}
