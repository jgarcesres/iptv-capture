import { chromium } from "playwright";

const CAPTURE_TIMEOUT_MS = parseInt(
  process.env.CAPTURE_TIMEOUT_MS || "45000"
);

/**
 * Captures the live HLS m3u8 URL from a single channel page.
 *
 * Opens a headless Chromium browser, navigates to the channel URL,
 * and intercepts network requests to find the master m3u8 playlist.
 *
 * @param {Object} channel - Channel config
 * @returns {Promise<string|null>} The captured m3u8 URL, or null on failure
 */
async function captureStream(channel) {
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

    // Collect all m3u8 URLs we see
    const m3u8Urls = [];

    // Log all network requests for debugging
    const allUrls = [];

    page.on("request", (request) => {
      const url = request.url();
      // Track media-related requests for debugging
      if (
        url.includes(".m3u8") ||
        url.includes(".mpd") ||
        url.includes("manifest") ||
        url.includes("stream") ||
        url.includes("mdstrm") ||
        url.includes("playlist")
      ) {
        console.log(`[capture] ${channel.id}: [req] ${url.substring(0, 150)}`);
        allUrls.push(url);
      }
      if (isM3u8Request(url, channel.capturePatterns)) {
        m3u8Urls.push(url);
      }
    });

    page.on("response", (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.includes("mpegurl") ||
        contentType.includes("x-mpegurl") ||
        contentType.includes("dash") ||
        isM3u8Request(url, channel.capturePatterns)
      ) {
        console.log(
          `[capture] ${channel.id}: [res] ${url.substring(0, 150)} (${contentType})`
        );
        if (!m3u8Urls.includes(url)) {
          m3u8Urls.push(url);
        }
      }
    });

    console.log(`[capture] ${channel.id}: navigating to ${channel.url}`);
    await page.goto(channel.url, {
      waitUntil: "networkidle",
      timeout: CAPTURE_TIMEOUT_MS,
    });

    console.log(`[capture] ${channel.id}: page loaded, waiting for stream...`);

    // Execute any page-specific actions (click play, dismiss modals, etc.)
    for (const action of channel.actions || []) {
      try {
        if (action.type === "click") {
          await page.click(action.selector, { timeout: 10000 });
          console.log(`[capture] ${channel.id}: clicked ${action.selector}`);
        } else if (action.type === "wait") {
          await page.waitForTimeout(action.ms || 3000);
        }
      } catch {
        console.warn(
          `[capture] ${channel.id}: action failed - ${action.type} ${action.selector || ""}`
        );
      }
    }

    // Try clicking common play button selectors
    const playSelectors = [
      "button[aria-label='Play']",
      ".vjs-big-play-button",
      ".play-button",
      "[class*='play']",
      "video",
    ];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          console.log(`[capture] ${channel.id}: auto-clicked ${sel}`);
          await page.waitForTimeout(3000);
          break;
        }
      } catch {
        // ignore
      }
    }

    // Wait for m3u8 request to appear
    const startTime = Date.now();
    while (m3u8Urls.length === 0 && Date.now() - startTime < CAPTURE_TIMEOUT_MS) {
      await page.waitForTimeout(2000);
    }

    // Log page title and URL for debugging
    console.log(
      `[capture] ${channel.id}: final URL=${page.url()}, tracked ${allUrls.length} media-related requests`
    );

    await context.close();

    if (m3u8Urls.length === 0) {
      console.warn(`[capture] ${channel.id}: no m3u8 URLs found`);
      return null;
    }

    // Prefer the master/main playlist (usually the first one, or one without
    // resolution-specific paths like _800, _480, etc.)
    const masterUrl = selectMasterPlaylist(m3u8Urls);
    console.log(
      `[capture] ${channel.id}: found ${m3u8Urls.length} m3u8 URL(s), selected: ${masterUrl.substring(0, 100)}...`
    );
    return masterUrl;
  } catch (err) {
    console.error(`[capture] ${channel.id}: error - ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Check if a URL matches the channel's capture patterns.
 */
function isM3u8Request(url, patterns = []) {
  const lowerUrl = url.toLowerCase();
  if (!lowerUrl.includes(".m3u8")) return false;
  if (patterns.length === 0) return true;
  return patterns.some((p) => lowerUrl.includes(p.toLowerCase()));
}

/**
 * Select the best (master) playlist from captured URLs.
 * Prefers URLs without resolution suffixes, or the "live-stream-playlist"
 * pattern from mdstrm.com.
 */
function selectMasterPlaylist(urls) {
  // Prefer master/main playlist patterns
  const master = urls.find(
    (u) =>
      u.includes("live-stream-playlist/") ||
      u.includes("master.m3u8") ||
      u.includes("index.m3u8")
  );
  if (master) return master;

  // Prefer URLs without resolution indicators
  const nonVariant = urls.find(
    (u) =>
      !/_\d+/.test(u) &&
      !/\/\d{3,4}\//.test(u) &&
      !u.includes("chunklist")
  );
  if (nonVariant) return nonVariant;

  return urls[0];
}

/**
 * Capture streams for all channels sequentially.
 * Sequential to avoid overwhelming the node with multiple Chromium instances.
 *
 * @param {Object[]} channels
 * @returns {Promise<Object>} Map of channel ID -> captured URL
 */
export async function captureAll(channels) {
  const results = {};
  for (const channel of channels) {
    results[channel.id] = await captureStream(channel);
  }
  return results;
}
