import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDjLine } from "../../../../lib/dj";
import { getProviderOrder, searchSongsByProvider, validatePlayableAudioUrl } from "../../../../lib/music";
import { pickNextTrack, pickPlayableBaseLibraryTrack } from "../../../../lib/queue";
import { loadRadioState } from "../../../../lib/radioState";
import { measureRuntimeStep, recordRuntimeEvent } from "../../../../lib/runtimeLog";
import { prepareDjTts } from "../../../../lib/tts";
import type { RadioNextResponse } from "../../../../lib/types";
import { ROLLING_QUEUE_TARGETS, WARMUP_CONFIG, type RollingQueueSlot, type RollingQueueSnapshot, type WarmupPackage } from "./queueTypes";

const PLAYER_DIR = path.join(process.cwd(), "data", "player");
const QUEUE_PATH = path.join(PLAYER_DIR, "rolling-queue-snapshot.json");
const WARMUP_PATH = path.join(PLAYER_DIR, "warmup-package.json");
const workers = { SeedWorker: "idle", TrackSelectionWorker: "idle", ScriptWorker: "idle", TtsWorker: "idle" } as const;
const TTS_PREPARE_TIMEOUT_MS = Number(process.env.QWEN3_TTS_TIMEOUT_MS ?? 300000);
const TTS_PREPARE_BUDGET_MS = Number(process.env.TTS_PRELOAD_BUDGET_MS ?? 300000);
let refillPromise: Promise<RollingQueueSnapshot> | null = null;

export async function loadRollingQueueSnapshot(): Promise<RollingQueueSnapshot> {
  try {
    const raw = await readFile(QUEUE_PATH, "utf8");
    const parsed = JSON.parse(stripBom(raw)) as RollingQueueSnapshot;
    return normalizeSnapshot(parsed);
  } catch {
    return emptySnapshot();
  }
}

export async function saveRollingQueueSnapshot(snapshot: RollingQueueSnapshot) {
  await mkdir(PLAYER_DIR, { recursive: true });
  const normalized = normalizeSnapshot({ ...snapshot, updatedAt: new Date().toISOString() });
  await writeFile(QUEUE_PATH, `${JSON.stringify(normalized, null, 2)}
`, "utf8");
  return normalized;
}

export async function refillRollingQueue(options: { allowTts?: boolean; force?: boolean } = {}) {
  if (refillPromise && !options.force) return refillPromise;
  refillPromise = doRefillRollingQueue(options).finally(() => {
    refillPromise = null;
  });
  return refillPromise;
}

async function doRefillRollingQueue(options: { allowTts?: boolean }) {
  const refillStartedAt = performance.now();
  void recordRuntimeEvent({ step: "rollingQueue.refill", status: "started", context: { allowTts: options.allowTts !== false } });
  let snapshot = await loadRollingQueueSnapshot();
  snapshot.refillRunning = true;
  snapshot.workers = { SeedWorker: "idle", TrackSelectionWorker: "idle", ScriptWorker: "idle", TtsWorker: "idle" };
  snapshot.queue = removeStaleAndPlayed(snapshot.queue).slice(0, ROLLING_QUEUE_TARGETS.maxQueueLength);
  await saveRollingQueueSnapshot(snapshot);

  try {
    snapshot = await promoteFirstTrackReadyToScript(snapshot);
    snapshot = await ensureTrackReady(snapshot);
    snapshot = await promoteFirstTrackReadyToScript(snapshot);
    if (options.allowTts !== false) {
      snapshot = await promoteFirstScriptReadyToTts(snapshot);
    }
    snapshot = await ensureSeedReadyPlaceholders(snapshot);
    snapshot.refillRunning = false;
    snapshot.workers = { SeedWorker: "idle", TrackSelectionWorker: "idle", ScriptWorker: "idle", TtsWorker: "idle" };
    const saved = await saveRollingQueueSnapshot(snapshot);
    void recordRuntimeEvent({ step: "rollingQueue.refill", status: "success", durationMs: Math.round(performance.now() - refillStartedAt), context: summarizeQueue(saved.queue) });
    return saved;
  } catch (cause) {
    snapshot.refillRunning = false;
    snapshot.workers = { SeedWorker: "idle", TrackSelectionWorker: "idle", ScriptWorker: "idle", TtsWorker: "failed" };
    snapshot.queue.push(failedSlot(cause));
    const saved = await saveRollingQueueSnapshot(snapshot);
    void recordRuntimeEvent({
      step: "rollingQueue.refill",
      status: "error",
      durationMs: Math.round(performance.now() - refillStartedAt),
      error: cause instanceof Error ? cause.message : String(cause),
      context: summarizeQueue(saved.queue)
    });
    return saved;
  }
}

export async function consumeBestRollingQueueItem(options: { requireTts?: boolean } = {}) {
  const snapshot = await loadRollingQueueSnapshot();
  const queue = removeStaleAndPlayed(snapshot.queue);
  const allowed = options.requireTts ? ["tts_ready"] : ["tts_ready", "script_ready", "track_ready"];

  while (true) {
    const index = queue.findIndex((slot) => slot.item && allowed.includes(slot.status));
    if (index < 0) {
      await saveRollingQueueSnapshot({ ...snapshot, queue: reindex(queue), refillRunning: false });
      return null;
    }

    const [slot] = queue.splice(index, 1);
    if (slot.item?.djContextDebug?.style === "soft_transition") {
      void recordRuntimeEvent({
        step: "rollingQueue.consume",
        status: "error",
        error: "stale_soft_transition_item",
        context: { track: `${slot.item.track.title} - ${slot.item.track.artist}`, status: slot.status }
      });
      continue;
    }

    if (slot.item && await isRecentlyPlayedItem(slot.item)) {
      void recordRuntimeEvent({
        step: "rollingQueue.consume",
        status: "error",
        error: "recent_duplicate_item",
        context: { track: `${slot.item.track.title} - ${slot.item.track.artist}`, status: slot.status }
      });
      continue;
    }

    if (slot.item && await isQueueItemPlayable(slot.item, `rolling_queue:${slot.status}`)) {
      await saveRollingQueueSnapshot({ ...snapshot, queue: reindex(queue), refillRunning: false });
      return slot.item;
    }

    void recordRuntimeEvent({
      step: "rollingQueue.consume",
      status: "error",
      error: "stale_unplayable_item",
      context: { track: slot.item ? `${slot.item.track.title} - ${slot.item.track.artist}` : "unknown", status: slot.status }
    });
  }
}

export async function buildImmediateRadioItem(input: { scene: "opening" | "normal" | "after_skip" | "after_like"; withTts: boolean; skipTts?: boolean; previousTrack?: { title: string; artist: string; album?: string } }) {
  const picked = await measureRuntimeStep("recommend.pickNextTrack", { scene: input.scene, withTts: input.withTts, skipTts: input.skipTts }, async () => {
    try {
      return await pickNextTrack();
    } catch (cause) {
      if (input.scene !== "opening") throw cause;
      return measureRuntimeStep("recommend.openingBaseFallback", { reason: cause instanceof Error ? cause.message : String(cause) }, () => pickPlayableBaseLibraryTrack(cause instanceof Error ? cause.message : String(cause)));
    }
  });
  const state = await loadRadioState();
  const dj = await measureRuntimeStep("dj.generateLine", { track: `${picked.track.title} - ${picked.track.artist}`, scene: input.scene, previousTrack: input.previousTrack ? `${input.previousTrack.title} - ${input.previousTrack.artist}` : null }, () => generateDjLine(picked.track, {
    sourceSeed: picked.sourceSeed,
    previousTrack: input.previousTrack,
    searchQuery: picked.searchQuery,
    reason: picked.reason,
    scene: input.scene,
    radioState: state
  }));
  const voice = input.withTts && !input.skipTts ? await prepareDjTts(dj, { timeoutMs: TTS_PREPARE_TIMEOUT_MS, budgetMs: TTS_PREPARE_BUDGET_MS }) : null;
  const item: RadioNextResponse = {
    track: {
      id: picked.track.id,
      title: picked.track.title,
      artist: picked.track.artist,
      album: picked.track.album,
      durationSec: picked.track.durationSeconds,
      coverUrl: picked.track.coverUrl ?? "",
      audioUrl: picked.track.audioUrl
    },
    djLine: dj.text,
    ttsUrl: voice?.audioUrl ?? null,
    ttsSkipped: Boolean(input.skipTts),
    searchQuery: picked.searchQuery,
    searchStrategy: picked.searchStrategy,
    tasteKeywordsUsed: picked.tasteKeywordsUsed,
    sourceSeed: picked.sourceSeed,
    reason: picked.reason,
    fallbackUsed: picked.fallbackUsed,
    liveFilteredCount: picked.liveFilteredCount,
    livePenaltyApplied: picked.livePenaltyApplied,
    providerTried: picked.providerTried,
    selectedProvider: picked.selectedProvider,
    candidateDebug: picked.candidateDebug,
    fallbackReason: picked.fallbackReason,
    djContextDebug: dj.debug,
    discovery: picked.discovery,
    rankerSourcePaths: picked.rankerSourcePaths,
    rankerScore: picked.rankerScore
  };
  return item;
}

export async function loadWarmupPackage() {
  try {
    const raw = await readFile(WARMUP_PATH, "utf8");
    const pkg = JSON.parse(stripBom(raw)) as WarmupPackage;
    return validateWarmupPackage(pkg);
  } catch {
    return null;
  }
}

export async function consumeWarmupPackage() {
  const pkg = await loadWarmupPackage();
  if (!pkg?.valid) return null;
  if (pkg.item.djContextDebug?.style === "soft_transition") {
    await invalidateWarmupPackage("stale_soft_transition");
    return null;
  }
  if (!await isQueueItemPlayable(pkg.item, "warmup")) {
    await invalidateWarmupPackage("unplayable_track_url");
    return null;
  }
  await invalidateWarmupPackage("consumed");
  return pkg.item;
}

export async function saveWarmupPackageFromItem(item: RadioNextResponse, sourceRunId = `warmup-${Date.now()}`) {
  if (!item.track.audioUrl || !item.ttsUrl) return null;
  if (item.djContextDebug?.style === "soft_transition") return null;
  if (!await isQueueItemPlayable(item, "warmup_save")) return null;
  const now = new Date();
  const expires = new Date(now.getTime() + WARMUP_CONFIG.defaultTtlHours * 36e5);
  const pkg: WarmupPackage = {
    id: `warmup-${now.getTime()}`,
    item,
    sourceRunId,
    seedRefs: [{ type: "track", title: item.sourceSeed.title, artist: item.sourceSeed.artist, album: item.sourceSeed.album, source: "base_library", weight: 1 }],
    moodTags: item.tasteKeywordsUsed,
    timeOfDay: "any",
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    valid: true
  };
  await mkdir(PLAYER_DIR, { recursive: true });
  await writeFile(WARMUP_PATH, `${JSON.stringify(pkg, null, 2)}
`, "utf8");
  void recordRuntimeEvent({ step: "warmup.save", status: "success", context: { track: `${item.track.title} - ${item.track.artist}`, hasTts: Boolean(item.ttsUrl), expiresAt: pkg.expiresAt } });
  return pkg;
}

export async function saveWarmupPackageFromQueue(sourceRunId = `warmup-queue-${Date.now()}`) {
  const snapshot = await loadRollingQueueSnapshot();
  const queue = removeStaleAndPlayed(snapshot.queue);
  const slot = queue.find((entry) => entry.status === "tts_ready" && entry.item?.ttsUrl && !entry.stale);
  if (!slot?.item) {
    void recordRuntimeEvent({ step: "warmup.save", status: "error", error: "no_tts_ready_queue_item", context: { sourceRunId } });
    return null;
  }
  return saveWarmupPackageFromItem(slot.item, slot.sourceRunId ?? sourceRunId);
}

export async function invalidateWarmupPackage(reason: string) {
  const pkg = await loadWarmupPackage();
  if (!pkg) return null;
  const invalid = { ...pkg, valid: false, invalidReason: reason };
  await mkdir(PLAYER_DIR, { recursive: true });
  await writeFile(WARMUP_PATH, `${JSON.stringify(invalid, null, 2)}
`, "utf8");
  void recordRuntimeEvent({ step: "warmup.invalidate", status: "info", context: { reason } });
  return invalid;
}

async function promoteFirstScriptReadyToTts(snapshot: RollingQueueSnapshot) {
  if (snapshot.queue.some((slot) => slot.status === "tts_ready" && slot.item?.ttsUrl)) return snapshot;
  const slot = snapshot.queue.find((entry) => entry.status === "script_ready" && entry.item && !entry.locked && !entry.stale);
  if (!slot?.item) return snapshot;
  snapshot.workers = { ...snapshot.workers, TtsWorker: "running" };
  await saveRollingQueueSnapshot(snapshot);
  const voice = await prepareDjTts({ text: slot.item.djLine, mood: "", source: "llm" }, { timeoutMs: TTS_PREPARE_TIMEOUT_MS, budgetMs: TTS_PREPARE_BUDGET_MS });
  if (voice.audioUrl) {
    slot.item.ttsUrl = voice.audioUrl;
    slot.status = "tts_ready";
    slot.locked = true;
    slot.updatedAt = new Date().toISOString();
    await saveWarmupPackageFromItem(slot.item, slot.sourceRunId);
  }
  snapshot.workers = { ...snapshot.workers, TtsWorker: "idle" };
  return saveRollingQueueSnapshot(snapshot);
}

async function promoteFirstTrackReadyToScript(snapshot: RollingQueueSnapshot) {
  if (snapshot.queue.some((slot) => slot.status === "script_ready" || slot.status === "tts_ready")) return snapshot;
  const slot = snapshot.queue.find((entry) => entry.status === "track_ready" && entry.item && !entry.stale);
  if (!slot?.item) return snapshot;
  snapshot.workers = { ...snapshot.workers, ScriptWorker: "running" };
  await saveRollingQueueSnapshot(snapshot);
  slot.status = "script_ready";
  slot.updatedAt = new Date().toISOString();
  snapshot.workers = { ...snapshot.workers, ScriptWorker: "idle" };
  return saveRollingQueueSnapshot(snapshot);
}

async function ensureTrackReady(snapshot: RollingQueueSnapshot) {
  const count = snapshot.queue.filter((slot) => ["track_ready", "script_ready", "tts_ready"].includes(slot.status)).length;
  if (count >= ROLLING_QUEUE_TARGETS.minTrackReady + ROLLING_QUEUE_TARGETS.minScriptReady + ROLLING_QUEUE_TARGETS.minTtsReady) return snapshot;
  snapshot.workers = { ...snapshot.workers, TrackSelectionWorker: "running" };
  await saveRollingQueueSnapshot(snapshot);
  const item = await buildNonDuplicateQueueItem(snapshot);
  if (!item) {
    snapshot.workers = { ...snapshot.workers, TrackSelectionWorker: "idle" };
    return saveRollingQueueSnapshot(snapshot);
  }
  snapshot.queue.push(makeSlot("script_ready", item));
  snapshot.workers = { ...snapshot.workers, TrackSelectionWorker: "idle" };
  return saveRollingQueueSnapshot({ ...snapshot, queue: reindex(snapshot.queue).slice(0, ROLLING_QUEUE_TARGETS.maxQueueLength) });
}

async function ensureSeedReadyPlaceholders(snapshot: RollingQueueSnapshot) {
  const seedCount = snapshot.queue.filter((slot) => slot.status === "seed_ready").length;
  for (let i = seedCount; i < ROLLING_QUEUE_TARGETS.minSeedReady; i += 1) {
    snapshot.queue.push(makeSlot("seed_ready"));
  }
  return saveRollingQueueSnapshot({ ...snapshot, queue: reindex(snapshot.queue).slice(0, ROLLING_QUEUE_TARGETS.maxQueueLength) });
}

export async function ensureRadioItemPlayable(item: RadioNextResponse, source = "api.next") {
  return isQueueItemPlayable(item, source);
}

async function isQueueItemPlayable(item: RadioNextResponse, source: string) {
  if (await validatePlayableAudioUrl(item.track.audioUrl, {
    title: item.track.title,
    artist: item.track.artist,
    source: item.selectedProvider ?? source,
    id: item.track.id
  })) {
    return true;
  }

  void recordRuntimeEvent({
    step: "player.preparedAudio.validate",
    status: "error",
    error: "unplayable_audio_url",
    context: {
      source,
      track: `${item.track.title} - ${item.track.artist}`,
      selectedProvider: item.selectedProvider ?? "",
      audioHost: safeHost(item.track.audioUrl)
    }
  });

  const alternate = await resolveAlternatePlayableTrack(item, source);
  if (!alternate) return false;
  item.track = { ...item.track, ...alternate.track, title: item.track.title, artist: item.track.artist, album: item.track.album };
  item.selectedProvider = alternate.selectedProvider;
  item.providerTried = Array.from(new Set([...(item.providerTried ?? []), ...alternate.providerTried]));
  void recordRuntimeEvent({
    step: "player.preparedAudio.resolve",
    status: "success",
    context: {
      source,
      track: `${item.track.title} - ${item.track.artist}`,
      selectedProvider: alternate.selectedProvider,
      audioHost: safeHost(item.track.audioUrl)
    }
  });
  return true;
}

async function resolveAlternatePlayableTrack(item: RadioNextResponse, source: string) {
  const excluded = new Set([item.selectedProvider, providerFromAudioUrl(item.track.audioUrl)].filter(Boolean).map((entry) => String(entry).toLowerCase()));
  const providerOrder = prioritizeFallbackProviders(getProviderOrder(), excluded);
  const queries = unique([`${item.track.title} ${item.track.artist}`.trim(), `${item.track.artist} ${item.track.title}`.trim(), item.track.title]);
  const providerTried: string[] = [];
  let best: { song: import("../../../../lib/types").Song; provider: string; score: number } | null = null;

  for (const provider of providerOrder) {
    providerTried.push(provider);
    for (const keyword of queries) {
      const songs = await searchSongsByProvider(provider as never, { keyword, limit: 5 }).catch(() => []);
      for (const song of songs) {
        if (!song.audioUrl || song.audioUrl === item.track.audioUrl) continue;
        const score = scoreAudioFallback(song, item.track);
        if (score < 55) continue;
        if (!best || score > best.score) best = { song, provider, score };
      }
      if (best && best.provider === provider && best.score >= 80) break;
    }
    if (best && best.provider === provider && best.score >= 80) break;
  }

  if (!best) {
    void recordRuntimeEvent({
      step: "player.preparedAudio.resolve",
      status: "error",
      error: "no_playable_alternate",
      context: { source, track: `${item.track.title} - ${item.track.artist}`, providerTried }
    });
    return null;
  }

  return {
    selectedProvider: best.provider,
    providerTried,
    track: {
      id: best.song.id,
      durationSec: best.song.durationSeconds,
      coverUrl: best.song.coverUrl ?? item.track.coverUrl,
      audioUrl: best.song.audioUrl
    }
  };
}

function prioritizeFallbackProviders(providers: string[], excludeProviders: Set<string>) {
  const preferred = ["spotify", "tencent", "apple", "netease"];
  return unique([...preferred, ...providers]).filter((provider) => !excludeProviders.has(provider));
}

function scoreAudioFallback(song: import("../../../../lib/types").Song, target: { title: string; artist: string; album?: string }) {
  let score = 0;
  const title = normalizeForAudioResolve(song.title);
  const targetTitle = normalizeForAudioResolve(target.title);
  const artist = normalizeForAudioResolve(song.artist);
  const targetArtist = normalizeForAudioResolve(target.artist);
  if (title === targetTitle) score += 55;
  else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 38;
  if (artist === targetArtist) score += 35;
  else if (artist.includes(targetArtist) || targetArtist.includes(artist)) score += 22;
  if (target.album && normalizeForAudioResolve(song.album) === normalizeForAudioResolve(target.album)) score += 8;
  if (/karaoke|ktv|濞村吋娼欓〃鏀焛nstrumental|tribute|cover|缂傚牐顕ч弫鐪emix|slowed|sped up|nightcore|\blive\b|闁绘粍婢樺┃鈧瑋婵犳洘鏌ㄩ弫杈ㄥ濞堚偓concert/i.test(`${song.title} ${song.album} ${song.artist}`)) score -= 45;
  return score;
}

function normalizeForAudioResolve(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function providerFromAudioUrl(value: string) {
  const lowered = value.toLowerCase();
  if (lowered.includes("music.126.net") || lowered.includes("netease")) return "netease";
  if (lowered.includes("spotify")) return "spotify";
  if (lowered.includes("tencent") || lowered.includes("qq.com")) return "tencent";
  if (lowered.includes("apple")) return "apple";
  return "";
}
function safeHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
function validateWarmupPackage(pkg: WarmupPackage): WarmupPackage | null {
  if (!pkg.valid) return pkg;
  if (new Date(pkg.expiresAt).getTime() <= Date.now()) return { ...pkg, valid: false, invalidReason: "expired" };
  if (!pkg.item?.track?.audioUrl) return { ...pkg, valid: false, invalidReason: "missing_track" };
  if (pkg.item.ttsUrl?.startsWith("/api/tts/file/")) {
    const file = pkg.item.ttsUrl.split("/").pop();
    if (file && !existsSync(path.join(process.cwd(), "data", "tts-cache", file))) return { ...pkg, valid: false, invalidReason: "missing_tts_file" };
  }
  return pkg;
}

function emptySnapshot(): RollingQueueSnapshot {
  return { sessionId: `session-${Date.now()}`, queue: [], refillRunning: false, workers: { ...workers }, updatedAt: new Date().toISOString() };
}

function normalizeSnapshot(snapshot: RollingQueueSnapshot): RollingQueueSnapshot {
  return { ...emptySnapshot(), ...snapshot, queue: reindex(dedupeQueue(snapshot.queue ?? [])) };
}

function makeSlot(status: RollingQueueSlot["status"], item?: RadioNextResponse): RollingQueueSlot {
  const now = new Date().toISOString();
  return { id: `${status}-${Date.now()}-${Math.random().toString(16).slice(2)}`, index: 0, status, item, locked: status === "tts_ready", stale: false, createdAt: now, updatedAt: now };
}

function failedSlot(cause: unknown): RollingQueueSlot {
  const slot = makeSlot("failed");
  slot.failureReason = cause instanceof Error ? cause.message : String(cause);
  return slot;
}

function reindex(queue: RollingQueueSlot[]) {
  return queue.map((slot, index) => ({ ...slot, index }));
}

function removeStaleAndPlayed(queue: RollingQueueSlot[]) {
  return reindex(dedupeQueue(queue.filter((slot) => !slot.stale && slot.status !== "played" && slot.status !== "failed")));
}


const QUEUE_STATUS_PRIORITY: Partial<Record<RollingQueueSlot["status"], number>> = {
  playing: 6,
  tts_ready: 5,
  script_ready: 4,
  track_ready: 3,
  candidate_pool_ready: 2,
  seed_ready: 1,
  empty: 0,
  played: -1,
  stale: -1,
  failed: -1
};

function dedupeQueue(queue: RollingQueueSlot[]) {
  const slotsByTrack = new Map<string, RollingQueueSlot>();
  const slotsWithoutTrack: RollingQueueSlot[] = [];

  for (const slot of queue) {
    const key = queueTrackKey(slot);
    if (!key) {
      slotsWithoutTrack.push(slot);
      continue;
    }

    const existing = slotsByTrack.get(key);
    if (!existing) {
      slotsByTrack.set(key, slot);
      continue;
    }

    const existingPriority = QUEUE_STATUS_PRIORITY[existing.status] ?? 0;
    const nextPriority = QUEUE_STATUS_PRIORITY[slot.status] ?? 0;
    if (nextPriority > existingPriority || (nextPriority === existingPriority && slot.updatedAt > existing.updatedAt)) {
      slotsByTrack.set(key, slot);
    }
  }

  const selected = new Set(slotsByTrack.values());
  return queue.filter((slot) => !queueTrackKey(slot) || selected.has(slot));
}

function queueTrackKey(slot: RollingQueueSlot) {
  const track = slot.item?.track;
  if (!track?.title || !track.artist) return "";
  return `${normalizeQueueText(track.title)}::${normalizeQueueText(track.artist)}`;
}

function normalizeQueueText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function buildNonDuplicateQueueItem(snapshot: RollingQueueSnapshot) {
  let lastItem: RadioNextResponse | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const item = await buildImmediateRadioItem({ scene: "normal", withTts: false, skipTts: false });
    lastItem = item;
    if (!await isRecentlyPlayedItem(item) && !isQueuedDuplicate(item, snapshot.queue)) return item;
    void recordRuntimeEvent({
      step: "rollingQueue.trackSelection",
      status: "error",
      error: "duplicate_candidate_rejected",
      context: { attempt, track: `${item.track.title} - ${item.track.artist}` }
    });
  }

  if (lastItem) {
    void recordRuntimeEvent({
      step: "rollingQueue.trackSelection",
      status: "error",
      error: "duplicate_candidate_exhausted",
      context: { track: `${lastItem.track.title} - ${lastItem.track.artist}` }
    });
  }
  return null;
}

async function isRecentlyPlayedItem(item: RadioNextResponse, window = 8) {
  const state = await loadRadioState();
  const key = radioItemTrackKey(item);
  const recentHistory = (state.playHistory ?? []).slice(-window);
  if (recentHistory.some((track) => `${normalizeQueueText(track.title)}::${normalizeQueueText(track.artist)}` === key)) return true;
  return (state.recentTracks ?? []).slice(0, window).some((entry) => recentTrackKey(entry) === key);
}

function isQueuedDuplicate(item: RadioNextResponse, queue: RollingQueueSlot[]) {
  const key = radioItemTrackKey(item);
  return queue.some((slot) => queueTrackKey(slot) === key);
}

function radioItemTrackKey(item: RadioNextResponse) {
  return `${normalizeQueueText(item.track.title)}::${normalizeQueueText(item.track.artist)}`;
}

function recentTrackKey(entry: string) {
  const parts = entry.split("::");
  if (parts.length >= 3) return `${normalizeQueueText(parts[1])}::${normalizeQueueText(parts.slice(2).join("::"))}`;
  return normalizeQueueText(entry);
}

function summarizeQueue(queue: RollingQueueSlot[]) {
  return {
    total: queue.length,
    ttsReady: queue.filter((slot) => slot.status === "tts_ready").length,
    scriptReady: queue.filter((slot) => slot.status === "script_ready").length,
    trackReady: queue.filter((slot) => slot.status === "track_ready").length,
    seedReady: queue.filter((slot) => slot.status === "seed_ready").length
  };
}

function unique<T extends string>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function stripBom(content: string) {
  return content.replace(/^\uFEFF/, "");
}










