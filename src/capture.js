import { chromium } from "playwright";

const CAPTURE_TIMEOUT_MS = parseInt(
  process.env.CAPTURE_TIMEOUT_MS || "45000"
);

/**
 * Captures the live stream URL from a channel using its configured method.
 *
 * Channels with `apiIntercept` config use Playwright to load the page and
 * intercept the API response containing the stream URL (for DRM-protected
 * players that won't play in headless Chromium).
 * Others use standard network request interception for stream manifests.
 */
async function captureStream(channel) {
  if (channel.apiIntercept) {
    return captureViaApiIntercept(channel);
  }
  return captureViaBrowser(channel);
}

/**
 * Capture stream URL by intercepting the player's API response.
 *
 * Some players (e.g., TBX) use DRM and won't play in headless Chromium,
 * but they still call their API to get the stream URL. We load the page
 * and intercept that API response to extract the manifest URL.
 */
async function captureViaApiIntercept(channel) {
  let browser;
  try {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    const { urlPattern, preferHls } = channel.apiIntercept;
    let streamUrl = null;

    // Intercept API responses that match the pattern
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes(urlPattern)) return;

      try {
        const data = await response.json();
        const entitlements = data.entitlements || [];

        // Find HLS or DASH media entitlement
        const hlsEntry = entitlements.find(
          (e) =>
            e.type === "media" &&
            e.contentType === "application/x-mpegURL"
        );
        const dashEntry = entitlements.find(
          (e) =>
            e.type === "media" &&
            e.contentType === "application/dash+xml"
        );
        const entry = preferHls !== false ? (hlsEntry || dashEntry) : (dashEntry || hlsEntry);

        if (entry?.url) {
          streamUrl = entry.url;
          console.log(
            `[capture] ${channel.id}: intercepted stream URL from API: ${streamUrl.substring(0, 120)}...`
          );
        }
      } catch {
        // Response wasn't JSON or didn't have expected structure
      }
    });

    console.log(`[capture] ${channel.id}: navigating to ${channel.url}`);
    await page.goto(channel.url, {
      waitUntil: "networkidle",
      timeout: CAPTURE_TIMEOUT_MS,
    });

    // Wait a bit more for the API call to complete if not found yet
    const startTime = Date.now();
    while (!streamUrl && Date.now() - startTime < CAPTURE_TIMEOUT_MS) {
      await page.waitForTimeout(2000);
    }

    await context.close();

    if (!streamUrl) {
      console.warn(`[capture] ${channel.id}: no stream URL intercepted from API`);
      return null;
    }

    return streamUrl;
  } catch (err) {
    console.error(`[capture] ${channel.id}: error - ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Capture stream URL via headless Chromium network request interception.
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
