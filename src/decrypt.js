import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CDM_DIR = process.env.CDM_DIR || "/app/cdm";
const HLS_OUTPUT_DIR = process.env.HLS_OUTPUT_DIR || "/app/cache";

/** @type {Map<string, {ffmpeg: import('child_process').ChildProcess, dashUrl: string, licenseUrl: string}>} */
const pipelines = new Map();

/**
 * Start (or restart) the decryption pipeline for a channel.
 *
 * Flow: Python (pywidevine) gets keys → ffmpeg decrypts DASH → local HLS output.
 */
export async function startDecryptPipeline(channelId, dashUrl, licenseUrl) {
  // Skip if already running with the same URLs
  const existing = pipelines.get(channelId);
  if (existing && existing.dashUrl === dashUrl && existing.licenseUrl === licenseUrl) {
    console.log(`[decrypt] ${channelId}: pipeline already running with same URLs`);
    return;
  }

  // Stop existing pipeline if URLs changed
  if (existing) {
    console.log(`[decrypt] ${channelId}: URLs changed, restarting pipeline`);
    stopDecryptPipeline(channelId);
  }

  const outputDir = join(HLS_OUTPUT_DIR, channelId);
  mkdirSync(outputDir, { recursive: true });

  try {
    // Step 1: Get decryption keys via Python/pywidevine
    console.log(`[decrypt] ${channelId}: extracting Widevine keys...`);
    const keys = await getDecryptionKeys(channelId, dashUrl, licenseUrl);

    if (!keys || keys.length === 0) {
      console.error(`[decrypt] ${channelId}: no keys obtained, aborting`);
      return;
    }

    console.log(`[decrypt] ${channelId}: got ${keys.length} content key(s)`);

    // Step 2: Start ffmpeg to decrypt DASH and output HLS
    const ffmpegProcess = startFfmpeg(channelId, dashUrl, keys, outputDir);
    pipelines.set(channelId, { ffmpeg: ffmpegProcess, dashUrl, licenseUrl });
  } catch (err) {
    console.error(`[decrypt] ${channelId}: pipeline failed - ${err.message}`);
  }
}

/**
 * Stop the decryption pipeline for a channel.
 */
export function stopDecryptPipeline(channelId) {
  const pipeline = pipelines.get(channelId);
  if (!pipeline) return;

  if (pipeline.ffmpeg && !pipeline.ffmpeg.killed) {
    console.log(`[decrypt] ${channelId}: stopping ffmpeg`);
    pipeline.ffmpeg.kill("SIGTERM");
    // Force kill after 5 seconds if it doesn't exit
    setTimeout(() => {
      if (!pipeline.ffmpeg.killed) {
        pipeline.ffmpeg.kill("SIGKILL");
      }
    }, 5000);
  }
  pipelines.delete(channelId);
}

/**
 * Check if a channel has a running decrypt pipeline.
 */
export function isDecryptRunning(channelId) {
  const pipeline = pipelines.get(channelId);
  return pipeline && pipeline.ffmpeg && !pipeline.ffmpeg.killed;
}

/**
 * Get the local HLS playlist path for a decrypted channel.
 * Returns null if no decrypted output exists yet.
 */
export function getDecryptedPlaylistPath(channelId) {
  const playlistPath = join(HLS_OUTPUT_DIR, channelId, "stream.m3u8");
  return existsSync(playlistPath) ? playlistPath : null;
}

/**
 * Read the local decrypted HLS playlist content.
 */
export function readDecryptedPlaylist(channelId) {
  const path = getDecryptedPlaylistPath(channelId);
  if (!path) return null;
  return readFileSync(path, "utf-8");
}

/**
 * Get the output directory for a channel's HLS segments.
 */
export function getHlsOutputDir(channelId) {
  return join(HLS_OUTPUT_DIR, channelId);
}

/**
 * Run the Python widevine script to get content decryption keys.
 */
function getDecryptionKeys(channelId, dashUrl, licenseUrl) {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [
      join(import.meta.dirname, "widevine.py"),
      dashUrl,
      licenseUrl,
      CDM_DIR,
    ]);

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (data) => { stdout += data; });
    py.stderr.on("data", (data) => {
      stderr += data;
      // Log Python output line by line
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        console.log(`[decrypt] ${channelId}: ${line}`);
      }
    });

    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`widevine.py exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const keys = JSON.parse(stdout.trim());
        resolve(keys);
      } catch (err) {
        reject(new Error(`Failed to parse widevine.py output: ${stdout}`));
      }
    });

    py.on("error", (err) => {
      reject(new Error(`Failed to spawn widevine.py: ${err.message}`));
    });
  });
}

/**
 * Start ffmpeg to decrypt a DASH stream and output as HLS.
 *
 * For CENC-encrypted DASH, ffmpeg needs decryption keys passed via
 * the -decryption_key option (one per key ID).
 */
function startFfmpeg(channelId, dashUrl, keys, outputDir) {
  const outputPath = join(outputDir, "stream.m3u8");

  // Build ffmpeg args
  const args = [];

  // Decryption keys — ffmpeg expects -decryption_key as input option
  // For multiple keys, use the first CONTENT key (typically there's only one)
  for (const { key } of keys) {
    args.push("-decryption_key", key);
  }

  args.push(
    "-i", dashUrl,
    "-c", "copy",           // No re-encoding, just remux
    "-f", "hls",
    "-hls_time", "4",       // 4-second segments
    "-hls_list_size", "20", // Keep 20 segments in the playlist
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", join(outputDir, "seg_%05d.ts"),
    outputPath,
  );

  console.log(`[decrypt] ${channelId}: starting ffmpeg → ${outputPath}`);

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let lastLog = 0;
  ffmpeg.stderr.on("data", (data) => {
    const now = Date.now();
    // Throttle ffmpeg logs to every 30 seconds
    if (now - lastLog > 30000) {
      const line = data.toString().trim().split("\n").pop();
      if (line) {
        console.log(`[decrypt] ${channelId}: ffmpeg: ${line.substring(0, 200)}`);
      }
      lastLog = now;
    }
  });

  ffmpeg.on("close", (code) => {
    console.log(`[decrypt] ${channelId}: ffmpeg exited with code ${code}`);
    pipelines.delete(channelId);

    // Auto-restart after a delay if it wasn't intentionally stopped
    if (code !== 0) {
      console.log(`[decrypt] ${channelId}: will restart in 10 seconds...`);
      setTimeout(() => {
        if (!pipelines.has(channelId)) {
          startDecryptPipeline(channelId, dashUrl, licenseUrl).catch((err) => {
            console.error(`[decrypt] ${channelId}: restart failed - ${err.message}`);
          });
        }
      }, 10000);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error(`[decrypt] ${channelId}: ffmpeg spawn error - ${err.message}`);
  });

  return ffmpeg;
}

/**
 * Stop all running pipelines (for graceful shutdown).
 */
export function stopAll() {
  for (const [channelId] of pipelines) {
    stopDecryptPipeline(channelId);
  }
}
