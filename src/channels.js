const DEFAULT_CHANNELS = [
  {
    id: "CaracolTV.co",
    name: "Caracol TV",
    url: "https://ditu.caracoltv.com/",
    logo: "https://i.imgur.com/WbfdJbk.png",
    // Caracol uses mdstrm.com CDN - look for m3u8 requests to that domain
    capturePatterns: ["mdstrm.com", ".m3u8"],
    // May need to click play or dismiss overlays
    actions: [],
  },
  {
    id: "CanalRCN.co",
    name: "Canal RCN",
    url: "https://www.canalrcn.com/co/senal-en-vivo",
    logo: "https://i.imgur.com/placeholder.png",
    capturePatterns: [".m3u8"],
    actions: [],
  },
];

/**
 * Returns channel configs from CHANNELS env var or defaults.
 */
export function getChannels() {
  if (process.env.CHANNELS) {
    try {
      return JSON.parse(process.env.CHANNELS);
    } catch (err) {
      console.error("[channels] Failed to parse CHANNELS env:", err.message);
    }
  }
  return DEFAULT_CHANNELS;
}
