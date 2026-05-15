import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function getTtsCacheDir() {
  const configured = process.env.TTS_CACHE_DIR || "data/tts-cache";
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

export function ensureTtsCacheDir() {
  const dir = getTtsCacheDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function normalizeTtsText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function buildTtsCacheKey(input: {
  provider: string;
  model: string;
  mode: string;
  speaker?: string;
  language: string;
  instruct: string;
  text: string;
}) {
  const body = [
    input.provider,
    input.model,
    input.mode,
    input.speaker || "default",
    input.language,
    input.instruct,
    normalizeTtsText(input.text)
  ].join("\n");
  return createHash("sha256").update(body).digest("hex");
}

export function getTtsCachePath(cacheKey: string, format: "wav" | "mp3" = "wav") {
  return path.join(ensureTtsCacheDir(), `${cacheKey}.${format}`);
}

export function getTtsAudioUrl(cacheKey: string, format: "wav" | "mp3" = "wav") {
  return `/api/tts/file/${cacheKey}.${format}`;
}

export function listTtsCache(limit = 50) {
  const dir = ensureTtsCacheDir();
  return readdirSync(dir)
    .filter((file) => /\.(wav|mp3)$/i.test(file))
    .map((file) => {
      const fullPath = path.join(dir, file);
      const stats = statSync(fullPath);
      return {
        file,
        audioUrl: `/api/tts/file/${file}`,
        size: stats.size,
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export function hasCachedTts(cacheKey: string, format: "wav" | "mp3" = "wav") {
  return existsSync(getTtsCachePath(cacheKey, format));
}

