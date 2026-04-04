const DEFAULT_CHANNELS = [
  {
    id: "CaracolTV.co",
    name: "Caracol TV",
    url: "https://ditu.caracoltv.com/",
    logo: "https://i.imgur.com/WbfdJbk.png",
    // Caracol uses mdstrm.com CDN — streams are DASH (.mpd) but HLS (.m3u8)
    // is also available at the same stream ID
    capturePatterns: ["mdstrm.com"],
    // The SPA needs: splash wait → cookie OK → channel click
    actions: [
      { type: "wait", ms: 18000 },
      { type: "click", selector: 'button:has-text("OK")' },
      { type: "wait", ms: 2000 },
      { type: "click", selector: 'button:has-text("Caracol TV")' },
    ],
    // Known stream ID — the HLS URL is predictable from the DASH stream ID
    // Pattern: https://mdstrm.com/live-stream-playlist/{streamId}.m3u8
    hlsTemplate: "https://mdstrm.com/live-stream-playlist/{streamId}.m3u8",
  },
  {
    id: "CanalRCN.co",
    name: "Canal RCN",
    url: "https://www.canalrcn.com/co/tv-en-vivo",
    logo: "https://upload.wikimedia.org/wikipedia/commons/a/a4/Canal_RCN_logo.svg",
    // RCN uses TBX player with Broadpeak CDN (DASH .mpd)
    // Stream autoplays after a preroll ad — no actions needed
    capturePatterns: [".mpd", "broadpeak.io"],
    actions: [
      { type: "wait", ms: 20000 },
    ],
  },
];

/**
 * Returns channel configs from CHANNELS env var or defaults.
 * Filters out disabled channels.
 */
export function getChannels() {
  let channels = DEFAULT_CHANNELS;
  if (process.env.CHANNELS) {
    try {
      channels = JSON.parse(process.env.CHANNELS);
    } catch (err) {
      console.error("[channels] Failed to parse CHANNELS env:", err.message);
    }
  }
  return channels.filter((ch) => !ch.disabled);
}
