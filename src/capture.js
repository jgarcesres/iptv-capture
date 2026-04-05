import { chromium } from "playwright";

const CAPTURE_TIMEOUT_MS = parseInt(
  process.env.CAPTURE_TIMEOUT_MS || "45000"
);

/**
 * Captures the live stream URL from a channel using its configured method.
 *
 * Channels with `api` config use direct API calls (faster, no browser needed).
 * Others use headless Chromium to intercept network requests.
 */
async function captureStream(channel) {
  if (channel.api) {
    return captureViaApi(channel);
  }
  return captureViaBrowser(channel);
}

/**
 * Capture stream URL via direct API calls (e.g., TBX Unity API).
 *
 * Flow: get anonymous JWT → fetch content URL → extract HLS/DASH manifest.
 */
async function captureViaApi(channel) {
  try {
    const { authUrl, contentUrl, clientId, headers: extraHeaders } = channel.api;

    // Step 1: Get anonymous auth token
    console.log(`[capture] ${channel.id}: fetching auth token from API`);
    const authResp = await fetch(authUrl, {
      headers: { "x-client-id": clientId, ...extraHeaders },
    });
    if (!authResp.ok) {
      console.error(`[capture] ${channel.id}: auth failed (${authResp.status})`);
      return null;
    }
    const authData = await authResp.json();
    const token = authData.access_token || authData.token;
    if (!token) {
      console.error(`[capture] ${channel.id}: no token in auth response`);
      return null;
    }

    // Step 2: Get content/stream URL
    console.log(`[capture] ${channel.id}: fetching stream URL from API`);
    const urlResp = await fetch(contentUrl, {
      headers: {
        "x-client-id": clientId,
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
    });
    if (!urlResp.ok) {
      console.error(`[capture] ${channel.id}: content URL failed (${urlResp.status})`);
      return null;
    }
    const urlData = await urlResp.json();

    // Step 3: Extract the best stream URL from entitlements
    const entitlements = urlData.entitlements || [];
    // Prefer HLS over DASH
    const hlsEntry = entitlements.find(
      (e) => e.type === "media" && e.contentType === "application/x-mpegURL"
    );
    const dashEntry = entitlements.find(
      (e) => e.type === "media" && e.contentType === "application/dash+xml"
    );
    const entry = hlsEntry || dashEntry;

    if (!entry?.url) {
      console.warn(`[capture] ${channel.id}: no stream URL in API response`);
      return null;
    }

    console.log(
      `[capture] ${channel.id}: captured stream URL via API: ${entry.url.substring(0, 120)}...`
    );
    return entry.url;
  } catch (err) {
    console.error(`[capture] ${channel.id}: API capture error - ${err.message}`);
    return null;
  }
}

/**
 * Capture stream URL via headless Chromium browser interception.
 */
async function captureViaBrowser(channel) {
  let browser;
  try {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    // Mask webdriver/automation signals that some players detect
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      delete window.__playwright;
      delete window.__pw_manual;
    });

    const streamUrls = [];

    page.on("request", (request) => {
      const url = request.url();
      if (isStreamRequest(url, channel.capturePatterns)) {
        streamUrls.push(url);
      }
    });

    page.on("response", (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.includes("mpegurl") ||
        contentType.includes("x-mpegurl") ||
        contentType.includes("dash+xml") ||
        isStreamRequest(url, channel.capturePatterns)
      ) {
        if (!streamUrls.includes(url)) {
          streamUrls.push(url);
        }
      }
    });

    console.log(`[capture] ${channel.id}: navigating to ${channel.url}`);
    await page.goto(channel.url, {
      waitUntil: channel.waitUntil || "domcontentloaded",
      timeout: CAPTURE_TIMEOUT_MS,
    });

    // Execute page-specific actions (wait for splash, click cookies, etc.)
    for (const action of channel.actions || []) {
      try {
        if (action.type === "click") {
          await page.click(action.selector, { timeout: 10000 });
          console.log(`[capture] ${channel.id}: clicked ${action.selector}`);
        } else if (action.type === "wait") {
          await page.waitForTimeout(action.ms || 3000);
        } else if (action.type === "waitForSelector") {
          await page.waitForSelector(action.selector, {
            timeout: action.ms || 15000,
          });
          console.log(`[capture] ${channel.id}: found ${action.selector}`);
        }
      } catch {
        console.warn(
          `[capture] ${channel.id}: action failed - ${action.type} ${action.selector || ""}`
        );
      }
    }

    // Wait for stream requests to appear
    const startTime = Date.now();
    while (
      streamUrls.length === 0 &&
      Date.now() - startTime < CAPTURE_TIMEOUT_MS
    ) {
      await page.waitForTimeout(2000);
    }

    await context.close();

    if (streamUrls.length === 0) {
      console.warn(`[capture] ${channel.id}: no stream URLs found`);
      return null;
    }

    // Convert to HLS if we got DASH/MPD
    const hlsUrl = toHlsUrl(streamUrls, channel);
    console.log(
      `[capture] ${channel.id}: found ${streamUrls.length} stream URL(s), HLS: ${hlsUrl ? hlsUrl.substring(0, 120) + "..." : "none"}`
    );
    return hlsUrl;
  } catch (err) {
    console.error(`[capture] ${channel.id}: error - ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Check if a URL is a stream manifest request.
 */
function isStreamRequest(url, patterns = []) {
  const lower = url.toLowerCase();
  const isStream = lower.includes(".m3u8") || lower.includes(".mpd");
  if (!isStream) return false;
  // Ignore ad-related manifests
  if (
    lower.includes("ads.") ||
    lower.includes("/ad/") ||
    lower.includes("imasdk")
  )
    return false;
  if (patterns.length === 0) return true;
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Convert captured stream URLs to an HLS m3u8 URL.
 *
 * For mdstrm.com (Caracol), the DASH stream ID can be used to construct
 * an HLS URL: https://mdstrm.com/live-stream-playlist/{streamId}.m3u8
 */
function toHlsUrl(urls, channel) {
  // First check if we already have an m3u8 URL
  const m3u8 = urls.find((u) => u.includes(".m3u8"));
  if (m3u8) return selectBestM3u8(urls.filter((u) => u.includes(".m3u8")));

  // If we have MPD URLs, try to derive the HLS URL
  const mpdUrl = urls.find((u) => u.includes(".mpd"));
  if (mpdUrl && channel.hlsTemplate) {
    const streamId = extractStreamId(mpdUrl);
    if (streamId) {
      return channel.hlsTemplate.replace("{streamId}", streamId);
    }
  }

  // Fallback: return the first MPD URL (Jellyfin can handle some DASH)
  return mpdUrl || urls[0];
}

/**
 * Extract the mdstrm.com stream ID from a URL.
 * Pattern: /live-stream-playlist/{id}.mpd or /live-stream-dai/{id}/...
 */
function extractStreamId(url) {
  const patterns = [
    /live-stream-playlist\/([a-f0-9]+)\./,
    /live-stream-dai\/([a-f0-9]+)\//,
    /live-stream\/([a-f0-9]+)\./,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return match[1];
  }
  return null;
}

/**
 * Select the best m3u8 URL from a list.
 */
function selectBestM3u8(urls) {
  const master = urls.find(
    (u) =>
      u.includes("live-stream-playlist/") ||
      u.includes("master.m3u8") ||
      u.includes("index.m3u8")
  );
  if (master) return master;

  const nonVariant = urls.find(
    (u) =>
      !/_\d+/.test(u) && !/\/\d{3,4}\//.test(u) && !u.includes("chunklist")
  );
  if (nonVariant) return nonVariant;

  return urls[0];
}

/**
 * Capture streams for all channels sequentially.
 */
export async function captureAll(channels) {
  const results = {};
  for (const channel of channels) {
    results[channel.id] = await captureStream(channel);
  }
  return results;
}
