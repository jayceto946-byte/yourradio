import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { DjContextDebug, DjScript, RadioState, Song, SourceSeed } from "./types";
import { formatTrackForSpeech } from "../src/lib/dj/formatTrackForSpeech";
import { researchSongFacts } from "../src/lib/dj/songResearch";
import type { SongFact, SongResearchResult } from "../src/lib/dj/songFacts";
import { recordLlmCacheStats } from "../src/lib/llm/cacheStats";
import { DJ_JSON_REPAIR_INSTRUCTION, DJ_SYSTEM_PROMPT, DJ_TASK_INSTRUCTION } from "../src/lib/llm/prompts/djSystemPrompt";
import { stableJsonStringify } from "../src/lib/llm/stableJson";
import { buildFallbackDjScript } from "../src/lib/dj/fallbackDjScript";
import { detectBannedDjInternalPhrase, sanitizeRecommendationReason } from "../src/lib/dj/djScriptSanitizer";
import { selectDjScriptMode, type DjScriptMode } from "../src/lib/dj/selectDjScriptMode";
import { buildTrackContextPack } from "../src/lib/knowledge/buildTrackContextPack";
import { selectDjScriptMode as selectKnowledgeDjScriptMode } from "../src/lib/knowledge/knowledgeCardGenerator";
import { saveDjScriptMemory } from "../src/lib/knowledge/knowledgeStore";
import type { TrackContextPack, DjScriptMode as KnowledgeDjScriptMode } from "../src/lib/knowledge/knowledgeTypes";
import { buildLlmRequestBody, LLM_CONFIG } from "./llmConfig";
import { loadLikedSongs, type LikedSongEntry } from "./likedSongs";

const LLM_TIMEOUT_MS = 8000;
const SONG_RESEARCH_TIMEOUT_MS = 3000;
const CHINESE_SONG_RESEARCH_TIMEOUT_MS = 2200;
const chineseTextPattern = /[\\u3400-\\u9fff]/;

const DJ_SCRIPT_CONFIG = {
  targetCharsExcludingTitle: 85,
  minCharsExcludingTitle: 50,
  maxCharsExcludingTitle: 110
};

const DJ_SCRIPT_BANNED_OVERUSED_OPENERS = [
  "接下来这首",
  "刚才那首之后",
  "现在把节奏",
  "这首和你最近",
  "下一首"
];

type DjScene = "opening" | "normal" | "after_skip" | "after_like" | "requested";

type GenerateDjLineOptions = {
  sourceSeed?: SourceSeed;
  previousTrack?: { title: string; artist: string; album?: string };
  searchQuery?: string;
  reason?: string;
  scene?: DjScene;
  radioState?: RadioState;
};

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type DeepSeekMessage = { role: "system" | "user"; content: string };

type DjJson = {
  djLine?: string;
  script?: string;
  tone?: string;
  usedContext?: string[];
  usedFactTypes?: string[];
  confidence?: "high" | "medium" | "low" | number;
};

type LastDjScriptDebug = {
  mode: DjScriptMode;
  usedTransition: boolean;
  isChineseTrackLikelyLowCoverage: boolean;
  researchStatus: string;
  factsCount: number;
  bannedPhraseDetected: boolean;
  fallbackUsed: boolean;
  track: { rawTitle: string; speechTitle: string; artist: string; displayArtist: string };
  research: { searched: boolean; wikiSearched: boolean; cached: boolean; triggerReasons: string[]; queries: string[]; wikiQueries: string[]; facts: SongFact[]; latencyMs: number };
  script: { text: string; usedFactTypes: string[]; charCountExcludingTitle: number; source: string };
};

let lastDjScriptDebug: LastDjScriptDebug | null = null;

export async function generateDjLine(song: Song, options: GenerateDjLineOptions = {}): Promise<DjScript> {
  const taste = await loadTaste();
  const debugContext = buildDebugContext(options.radioState, taste.loaded);
  const speech = formatTrackForSpeech({ title: song.title, artist: song.artist, album: song.album });
  const research = await researchWithTimeout(song, options, speech);
  const facts = research.facts.slice(0, 5);
  const contextPack = await buildDjTrackContextPack(song, options, speech, research);
  const knowledgeMode = selectKnowledgeDjScriptMode(contextPack);
  const mode = selectDjScriptMode({
    factsCount: facts.length,
    hasHighConfidenceFact: facts.some((fact) => fact.confidence >= 0.68),
    recentScriptModes: getRecentScriptModes(options.radioState),
    previousTrackAvailable: Boolean(options.previousTrack),
    isChineseTrackLikelyLowCoverage: Boolean(research.isChineseTrackLikelyLowCoverage)
  });

  if (!LLM_CONFIG.apiKey) {
    return buildFallback(song, options, debugContext, "missing_api_key", speech, facts, mode, research);
  }

  const messages = buildDjMessages(song, options, taste.content, debugContext, speech, research, mode, contextPack, knowledgeMode);

  try {
    const first = await requestDeepSeek(messages);
    const firstResult = parseAndValidateDjResponse(first.data, options.radioState, speech, facts, options.sourceSeed, options.previousTrack);
    if (firstResult.line) {
      return buildLlmResult(song, options, debugContext, speech, research, firstResult.line, firstResult.parsed, facts, mode);
    }

    const retry = await requestDeepSeek([...messages, { role: "user", content: DJ_JSON_REPAIR_INSTRUCTION }]);
    const retryResult = parseAndValidateDjResponse(retry.data, options.radioState, speech, facts, options.sourceSeed, options.previousTrack);
    if (retryResult.line) {
      return buildLlmResult(song, options, debugContext, speech, research, retryResult.line, retryResult.parsed, facts, mode);
    }

    return buildFallback(song, options, debugContext, "invalid_llm_output", speech, facts, mode, research);
  } catch (cause) {
    return buildFallback(song, options, debugContext, cause instanceof Error ? cause.message : "llm_error", speech, facts, mode, research);
  }
}
function buildDjMessages(
  song: Song,
  options: GenerateDjLineOptions,
  taste: string,
  debug: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  mode: DjScriptMode,
  contextPack: TrackContextPack,
  knowledgeMode: KnowledgeDjScriptMode
): DeepSeekMessage[] {
  return [
    { role: "system", content: DJ_SYSTEM_PROMPT },
    { role: "user", content: DJ_TASK_INSTRUCTION },
    { role: "user", content: stableJsonStringify(buildDjPayload(song, options, taste, debug, speech, research, mode, contextPack, knowledgeMode)) }
  ];
}

function buildDjPayload(
  song: Song,
  options: GenerateDjLineOptions,
  taste: string,
  debug: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  mode: DjScriptMode,
  contextPack: TrackContextPack,
  knowledgeMode: KnowledgeDjScriptMode
) {
  const previous = mode === "soft_transition" ? options.previousTrack : undefined;
  return {
    trackContextPack: compactTrackContextPack(contextPack),
    scriptMode: knowledgeMode,
    facts: research.facts.slice(0, 5).map((fact) => ({
      confidence: fact.confidence,
      text: fact.text,
      type: fact.type
    })),
    nextTrack: {
      album: song.album,
      displayArtist: speech.displayArtist,
      rawTitle: song.title,
      speechTitle: speech.speechTitle
    },
    previousTrack: previous ? { artist: previous.artist, title: previous.title } : undefined,
    recentDjOpenings: options.radioState?.recentDjLines?.slice(0, 3).map((line) => line.slice(0, 18)) ?? [],
    recentTracks: options.radioState?.playHistory.slice(-3).map((entry) => ({ artist: entry.artist, title: entry.title })) ?? [],
    sessionPreviousTrack: options.previousTrack ? { artist: options.previousTrack.artist, title: options.previousTrack.title } : undefined,
    fallbackAllowed: true,
    mode,
    recommendationReason: sanitizeDjRecommendationReason(options.reason),
    research: {
      confidence: contextPack.confidence,
      hasTrackCard: Boolean(contextPack.knowledge.trackCard),
      hasAlbumCard: Boolean(contextPack.knowledge.albumCard),
      hasArtistCard: Boolean(contextPack.knowledge.artistCard)
    },
    scene: options.scene ?? "normal",
    scoreExplanation: sanitizeDjRecommendationReason(options.reason),
    seedContext: buildSeedContext(options.sourceSeed),
    sourceSeed: undefined,
    taste: taste ? taste.slice(0, 900) : "taste not provided",
    timeOfDay: debug.timeOfDay
  };
}
async function buildDjTrackContextPack(
  song: Song,
  options: GenerateDjLineOptions,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult
) {
  const likedContext = await buildLikedSongContext(song, speech);

  return buildTrackContextPack({
    track: {
      title: speech.speechTitle,
      artist: speech.displayArtist,
      album: song.album
    },
    recommendation: {
      seedTrack: options.sourceSeed?.title,
      seedArtist: options.sourceSeed?.artist,
      reason: sanitizeDjRecommendationReason(options.reason),
      sourcePath: undefined,
      likedContext,
      tags: research.facts
        .filter((fact) => fact.type === "metadata")
        .map((fact) => fact.text)
        .slice(0, 3)
    },
    listeningContext: {
      previousTrack: options.previousTrack ? { title: options.previousTrack.title, artist: options.previousTrack.artist } : undefined,
      position: options.scene === "opening" ? "opening" : options.scene === "requested" ? "requested" : "normal",
      userAction: options.scene === "after_like" ? "like_style" : options.scene === "after_skip" ? "skip_downrank" : "none"
    }
  });
}

async function buildLikedSongContext(song: Song, speech: ReturnType<typeof formatTrackForSpeech>) {
  const likedSongs = await loadLikedSongs().catch(() => []);
  if (!likedSongs.length) return undefined;

  const currentTitle = speech.speechTitle || song.title;
  const currentArtist = speech.displayArtist || song.artist;
  const currentAlbum = song.album ?? "";

  const sameArtist = likedSongs
    .filter((entry) => isSameArtist(entry.artist, currentArtist))
    .filter((entry) => !isSameTrack(entry, currentTitle, currentArtist))
    .slice(0, 3)
    .map(toLikedContextItem);

  const sameAlbum = likedSongs
    .filter((entry) => Boolean(currentAlbum) && isSameArtist(entry.artist, currentArtist) && isSameAlbum(entry.album, currentAlbum))
    .filter((entry) => !isSameTrack(entry, currentTitle, currentArtist))
    .slice(0, 3)
    .map(toLikedContextItem);

  if (!sameArtist.length && !sameAlbum.length) return undefined;

  return {
    sameArtist,
    sameAlbum,
    summary: [
      sameAlbum.length ? "listener_liked_same_album_before" : undefined,
      sameArtist.length ? "listener_liked_same_artist_before" : undefined
    ].filter(Boolean).join(";")
  };
}

function toLikedContextItem(entry: LikedSongEntry) {
  return {
    title: entry.title,
    artist: entry.artist,
    album: entry.album || undefined,
    likedAt: entry.likedAt,
    feedbackAction: entry.feedbackAction
  };
}

function compactLikedContext(context: TrackContextPack["recommendation"]["likedContext"]) {
  if (!context) return undefined;
  return {
    summary: context.summary,
    sameArtist: context.sameArtist?.slice(0, 2).map(compactLikedContextItem),
    sameAlbum: context.sameAlbum?.slice(0, 2).map(compactLikedContextItem)
  };
}

function compactLikedContextItem(item: { title: string; artist: string; album?: string; feedbackAction?: "like" | "like_style" }) {
  return {
    title: item.title,
    artist: item.artist,
    album: item.album,
    feedbackAction: item.feedbackAction
  };
}

function isSameTrack(entry: LikedSongEntry, title: string, artist: string) {
  return normalizeForMention(entry.title) === normalizeForMention(title) && isSameArtist(entry.artist, artist);
}

function isSameArtist(left: string, right: string) {
  const a = normalizeForMention(left);
  const b = normalizeForMention(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function isSameAlbum(left: string, right: string) {
  const a = normalizeForMention(left);
  const b = normalizeForMention(right);
  return Boolean(a && b && a === b);
}

function compactTrackContextPack(context: TrackContextPack) {
  return {
    track: context.track,
    recommendation: {
      seedTrack: context.recommendation.seedTrack,
      seedArtist: context.recommendation.seedArtist,
      sourcePath: context.recommendation.sourcePath,
      reason: context.recommendation.reason,
      likedContext: compactLikedContext(context.recommendation.likedContext),
      tags: context.recommendation.tags?.slice(0, 5),
      similarTo: context.recommendation.similarTo?.slice(0, 3)
    },
    knowledge: {
      trackCard: context.knowledge.trackCard ? compactTrackCard(context.knowledge.trackCard) : undefined,
      albumCard: context.knowledge.albumCard ? compactAlbumCard(context.knowledge.albumCard) : undefined,
      artistCard: context.knowledge.artistCard ? compactArtistCard(context.knowledge.artistCard) : undefined,
      scriptMemory: context.knowledge.scriptMemory && context.knowledge.scriptMemory.userFeedback !== "bad"
        ? { script: context.knowledge.scriptMemory.script, mode: context.knowledge.scriptMemory.mode, userFeedback: context.knowledge.scriptMemory.userFeedback }
        : undefined
    },
    listeningContext: context.listeningContext,
    confidence: context.confidence
  };
}

function compactTrackCard(card: NonNullable<TrackContextPack["knowledge"]["trackCard"]>) {
  return {
    title: card.title,
    artist: card.artist,
    album: card.album,
    tags: card.tags?.slice(0, 5),
    summary: card.summary,
    lyricTheme: card.lyricTheme,
    moodWords: card.moodWords?.slice(0, 5),
    djAngles: card.djAngles?.slice(0, 3),
    confidence: card.confidence
  };
}

function compactAlbumCard(card: NonNullable<TrackContextPack["knowledge"]["albumCard"]>) {
  return {
    album: card.album,
    artist: card.artist,
    year: card.year,
    tags: card.tags?.slice(0, 5),
    summary: card.summary,
    moodWords: card.moodWords?.slice(0, 5),
    djAngles: card.djAngles?.slice(0, 3),
    confidence: card.confidence
  };
}

function compactArtistCard(card: NonNullable<TrackContextPack["knowledge"]["artistCard"]>) {
  return {
    artist: card.artist,
    tags: card.tags?.slice(0, 5),
    shortBio: card.shortBio,
    moodWords: card.moodWords?.slice(0, 5),
    knownFor: card.knownFor?.slice(0, 4),
    confidence: card.confidence
  };
}

function rememberDjScript(song: Song, speech: ReturnType<typeof formatTrackForSpeech>, line: string, mode: DjScriptMode) {
  saveDjScriptMemory({
    trackTitle: speech.speechTitle,
    artist: speech.displayArtist,
    album: song.album,
    script: line,
    mode: mapMemoryMode(mode),
    userFeedback: "neutral"
  }).catch(() => undefined);
}

function mapMemoryMode(mode: DjScriptMode): KnowledgeDjScriptMode {
  if (mode === "song_fact") return "album_context";
  if (mode === "soft_transition") return "soft_transition";
  if (mode === "direct_play") return "direct_play";
  if (mode === "personal_taste_note") return "queue_reason";
  return "mood_note";
}
async function requestDeepSeek(messages: DeepSeekMessage[]) {
  const response = await fetchWithTimeout(LLM_CONFIG.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${LLM_CONFIG.apiKey}`
    },
    body: JSON.stringify(buildLlmRequestBody({
      messages,
      model: LLM_CONFIG.model,
      max_tokens: 420,
      response_format: { type: "text" },
      stream: false,
      temperature: 1.05,
      top_p: 0.95
    }, {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stop: null,
      stream_options: null,
      tools: null,
      tool_choice: "none",
      logprobs: false,
      top_logprobs: null
    })),
    cache: "no-store"
  }, LLM_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }

  const data = (await response.json()) as DeepSeekResponse;
  recordLlmCacheStats({ task: "dj_script", usage: data.usage });
  return { data };
}

function parseAndValidateDjResponse(
  data: DeepSeekResponse,
  state: RadioState | undefined,
  speech: ReturnType<typeof formatTrackForSpeech>,
  facts: SongFact[],
  sourceSeed?: SourceSeed,
  previousTrack?: { title: string; artist: string }
) {
  const raw = data.choices?.[0]?.message?.content?.trim();
  const parsed = parseDjJson(raw);
  const line = validateDjLine(cleanDjLine(parsed?.djLine ?? parsed?.script ?? raw), state, speech, sourceSeed, previousTrack);
  return { line, parsed, usedFactTypes: normalizeUsedFactTypes(parsed?.usedFactTypes, facts) };
}

function buildLlmResult(
  song: Song,
  options: GenerateDjLineOptions,
  debugContext: DjContextDebug,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  line: string,
  parsed: DjJson | null,
  facts: SongFact[],
  mode: DjScriptMode
): DjScript {
  const usedFactTypes = normalizeUsedFactTypes(parsed?.usedFactTypes, facts);
  const result: DjScript = {
    mood: parsed?.tone ?? "DeepSeek",
    text: line,
    source: "llm",
    style: mode,
    debug: {
      ...debugContext,
      tone: parsed?.tone,
      usedContext: [
        ...new Set([
          ...(parsed?.usedContext ?? []),
          "speechTitle",
          "displayArtist",
          "facts",
          ...usedFactTypes.map((type) => `fact:${type}`)
        ])
      ],
      confidence: normalizeConfidence(parsed?.confidence),
      source: "llm",
      style: mode
    }
  };
  rememberDjScript(song, speech, result.text, mode);
  setLastDjScriptDebug(song, speech, research, result.text, usedFactTypes, "llm", mode, false);
  return result;
}
function buildFallback(
  song: Song,
  options: GenerateDjLineOptions,
  debug: DjContextDebug,
  error: string,
  speech = formatTrackForSpeech({ title: song.title, artist: song.artist, album: song.album }),
  facts: SongFact[] = [],
  mode: DjScriptMode = "mood_note",
  research?: SongResearchResult
): DjScript {
  const text = buildFallbackDjScript({
    speechTitle: speech.speechTitle,
    displayArtist: speech.displayArtist,
    mode,
    timeOfDay: debug.timeOfDay,
    hasFacts: facts.length > 0
  });
  const result: DjScript = {
    mood: "fallback",
    text,
    source: "fallback",
    style: mode,
    error,
    debug: {
      ...debug,
      usedContext: [...debug.usedContext, "speechTitle", "displayArtist", "fallbackTemplate", `mode:${mode}`],
      source: "fallback",
      style: mode,
      error
    }
  };
  setLastDjScriptDebug(song, speech, research ?? {
    trackTitle: song.title,
    artist: song.artist,
    album: song.album,
    facts,
    usedProviders: [],
    searched: false,
    wikiSearched: false,
    cached: false,
    latencyMs: 0,
    queries: [],
    wikiQueries: [],
    triggerReasons: [],
    errors: [],
    researchStatus: "fallback",
    isChineseTrackLikelyLowCoverage: false
  }, result.text, [], "fallback", mode, true);
  return result;
}

function validateDjLine(line: string, state: RadioState | undefined, speech: ReturnType<typeof formatTrackForSpeech>, sourceSeed?: SourceSeed, previousTrack?: { title: string; artist: string }) {
  const text = line.trim();

  if (!text || text.length < 20 || text.length > 230) {
    return "";
  }

  if (/```|^\{|"djLine"|作为AI|以下是|歌词|发行于\d{4}|\d{4}年发行/.test(text)) {
    return "";
  }

  if (speech.removedTitleParts.some((part) => part && text.includes(part))) {
    return "";
  }

  if (detectBannedDjInternalPhrase(text)) {
    return "";
  }

  if (misusesSeedAsPreviousTrack(text, state, sourceSeed, previousTrack)) {
    return "";
  }

  if (state?.recentDjLines?.some((recent) => similarOpening(recent, text) || hasRepeatedOverusedOpener(text, [recent]))) {
    return "";
  }

  return text;
}

function misusesSeedAsPreviousTrack(text: string, state: RadioState | undefined, sourceSeed?: SourceSeed, previousTrack?: { title: string; artist: string }) {
  if (!mentionsPreviousTrack(text)) return false;
  const previous = previousTrack;
  if (!previous) return true;

  const previousTitle = normalizeForMention(previous.title);
  const previousArtist = normalizeForMention(previous.artist);
  const normalizedText = normalizeForMention(text);
  const mentionsRealPrevious = Boolean(previousTitle && normalizedText.includes(previousTitle))
    || Boolean(previousArtist && normalizedText.includes(previousArtist));

  if (mentionsRealPrevious) return false;

  const seedTitle = normalizeForMention(sourceSeed?.title ?? "");
  const seedArtist = normalizeForMention(sourceSeed?.artist ?? "");
  const mentionsSeed = Boolean(seedTitle && normalizedText.includes(seedTitle))
    || Boolean(seedArtist && normalizedText.includes(seedArtist));

  return mentionsSeed || true;
}

function mentionsPreviousTrack(text: string) {
  return /上一首|上一曲|上首|刚才那首|剛才那首|刚刚那首|前一首|前一曲|上一段|刚才的|剛才的/.test(text);
}

function normalizeForMention(value: string) {
  return value.toLowerCase().replace(/[《》「」“”'"\s\-_:：，,。.!！?？()（）\[\]]+/g, "").trim();
}

function buildSeedContext(seed?: SourceSeed) {
  if (!seed) return undefined;
  const label = [seed.title, seed.artist].filter(Boolean).join(" - ") || seed.album || "";
  if (!label) return undefined;
  return {
    label,
    rule: "推荐来源，不是真实上一首；不要称它为上一首、刚才那首或前一首。"
  };
}

function sanitizeDjRecommendationReason(value?: string) {
  const sanitized = sanitizeRecommendationReason(value);
  if (!sanitized) return "";
  return sanitized
    .replace(/SeedMode\s+base_random\.?/ig, "")
    .replace(/Used seeds?:.*?(?=Ranker score|$)/ig, "")
    .replace(/Ranker score.*$/ig, "")
    .replace(/seedMode=.*?(;|$)/ig, "")
    .replace(/seed[:：][^。；;，,]+/ig, "")
    .replace(/\s+/g, " ")
    .replace(/[，,。；;：:]{2,}/g, "，")
    .trim()
    .slice(0, 90);
}
function cleanDjLine(line?: string) {
  return (line ?? "")
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^主播[:：]/, "")
    .trim();
}

function parseDjJson(raw?: string): DjJson | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(jsonText) as DjJson;
  } catch {
    return null;
  }
}

function similarOpening(a: string, b: string) {
  return getOpening(a) === getOpening(b);
}

function hasRepeatedOverusedOpener(text: string, recent: string[]) {
  const opener = DJ_SCRIPT_BANNED_OVERUSED_OPENERS.find((item) => text.startsWith(item));
  return Boolean(opener && recent.some((line) => line.startsWith(opener)));
}

function getOpening(value: string) {
  return value.replace(/^[《「“\s]+/, "").slice(0, 12);
}

function pickStyle(scene?: DjScene, salt = Math.floor(Math.random() * 8)) {
  if (scene === "after_skip") return "skip-reset";
  if (scene === "after_like") return "like-extension";
  const styles = ["opening", "transition", "mood", "time", "seed", "fact", "light", "night"];
  return styles[salt % styles.length];
}

function buildDebugContext(state: RadioState | undefined, tasteLoaded: boolean): DjContextDebug {
  const hour = new Date().getHours();
  const timeOfDay = hour < 6 ? "深夜" : hour < 11 ? "上午" : hour < 14 ? "午间" : hour < 18 ? "下午" : hour < 22 ? "夜晚" : "深夜";
  return {
    usedContext: ["artist", "album", "sourceSeed", "reason", "recentTracks", "recentDjLines", "timeOfDay", "taste"],
    confidence: "medium",
    timeOfDay,
    recentTracks: state?.playHistory.slice(-5).map((entry) => `${entry.title} - ${entry.artist}`) ?? [],
    tasteLoaded
  };
}

async function researchWithTimeout(song: Song, options: GenerateDjLineOptions, speech: ReturnType<typeof formatTrackForSpeech>) {
  const timeoutMs = chineseTextPattern.test(`${song.title} ${song.artist}`) ? CHINESE_SONG_RESEARCH_TIMEOUT_MS : SONG_RESEARCH_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      researchSongFacts({
        rawTitle: song.title,
        speechTitle: speech.speechTitle,
        rawArtist: song.artist,
        displayArtist: speech.displayArtist,
        album: song.album,
        recommendationReason: sanitizeDjRecommendationReason(options.reason),
        prepareTimeBudgetMs: timeoutMs,
        isSoundtrackLike: speech.isSoundtrackLike,
        featuredArtists: speech.featuredArtists
      }),
      new Promise<SongResearchResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          trackTitle: song.title,
          artist: song.artist,
          album: song.album,
          facts: [],
          usedProviders: [],
          searched: false,
          wikiSearched: false,
                cached: false,
          latencyMs: timeoutMs,
          queries: [],
          wikiQueries: [],
                errors: ["song_research_timeout"],
          researchStatus: "timeout",
          isChineseTrackLikelyLowCoverage: chineseTextPattern.test(`${song.title} ${song.artist}`)
        }), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadTaste() {
  try {
    const content = await readFile(path.join(process.cwd(), "user", "taste.md"), "utf8");
    return { loaded: true, content: content.slice(0, 1600) };
  } catch {
    return { loaded: false, content: "" };
  }
}

function normalizeConfidence(value: DjJson["confidence"]): "high" | "medium" | "low" {
  if (value === "high" || value === "medium" || value === "low") return value;
  if (typeof value === "number") return value >= 0.75 ? "high" : value >= 0.45 ? "medium" : "low";
  return "medium";
}

function normalizeUsedFactTypes(values: string[] | undefined, facts: SongFact[]) {
  const available = new Set(facts.map((fact) => fact.type));
  return (values ?? []).filter((value) => available.has(value as SongFact["type"]));
}

function getEnvValue(name: string): string | undefined;
function getEnvValue(name: string, fallback: string): string;
function getEnvValue(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export const generateMockDjScript = generateDjLine;





function setLastDjScriptDebug(
  song: Song,
  speech: ReturnType<typeof formatTrackForSpeech>,
  research: SongResearchResult,
  text: string,
  usedFactTypes: string[],
  source: string,
  mode: DjScriptMode,
  fallbackUsed: boolean
) {
  const bannedPhrase = detectBannedDjInternalPhrase(text);
  lastDjScriptDebug = {
    mode,
    usedTransition: mode === "soft_transition",
    isChineseTrackLikelyLowCoverage: Boolean(research.isChineseTrackLikelyLowCoverage),
    researchStatus: research.researchStatus ?? (research.errors.length ? "fallback" : "success"),
    factsCount: research.facts.length,
    bannedPhraseDetected: Boolean(bannedPhrase),
    fallbackUsed,
    track: { rawTitle: song.title, speechTitle: speech.speechTitle, artist: song.artist, displayArtist: speech.displayArtist },
    research: {
      searched: research.searched,
      wikiSearched: research.wikiSearched,
      cached: research.cached,
      triggerReasons: research.triggerReasons ?? [],
      queries: research.queries ?? [],
      wikiQueries: research.wikiQueries ?? [],
      facts: research.facts,
      latencyMs: research.latencyMs
    },
    script: {
      text,
      usedFactTypes,
      charCountExcludingTitle: Math.max(0, text.length - speech.speechTitle.length - speech.displayArtist.length),
      source
    }
  };
}

function getRecentScriptModes(state?: RadioState): DjScriptMode[] {
  const inferred = state?.recentDjLines?.slice(0, 5).map((line) => {
    if (/刚才|上一首|转场|接上/.test(line)) return "soft_transition" as const;
    if (line.length < 34) return "direct_play" as const;
    return "mood_note" as const;
  }) ?? [];
  return lastDjScriptDebug ? [lastDjScriptDebug.mode, ...inferred] : inferred;
}

export function getLastDjScriptDebug() {
  return lastDjScriptDebug;
}




























