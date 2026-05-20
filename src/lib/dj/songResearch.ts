import { getSongResearchCache, saveSongResearchCache } from "../../../lib/db";
import type { SongFact, SongResearchResult } from "./songFacts";
import { computePopularityScore } from "./songPopularity";
import { searchWikiSongInfo } from "./WikiSongInfoProvider";
import { getLastfmTrackInfoFacts } from "../providers/LastfmInfoProvider";
import { updateKnowledgeCardsFromFacts } from "../knowledge/knowledgeCardGenerator";

export const SONG_RESEARCH_CONFIG = {
  enabled: true,
  wikiEnabled: process.env.WIKI_SEARCH_ENABLED !== "false",
  lastfmInfoEnabled: process.env.LASTFM_TRACK_INFO_ENABLED !== "false",
  lastfmInfoMaxLatencyMs: Number(process.env.LASTFM_TRACK_INFO_MAX_LATENCY_MS ?? 1600),
  wikiMaxLatencyMs: Number(process.env.WIKI_MAX_LATENCY_MS ?? 1800),
  maxTotalResearchLatencyMs: 3000,
  chineseTrackWikiMaxLatencyMs: 1200,
  chineseTrackLastfmInfoMaxLatencyMs: 1100,
  chineseTrackMaxTotalResearchLatencyMs: 2200,
  maxFactsPassedToLLM: 6,
  minHighConfidenceWikiFacts: 2,
  cacheTtlDays: Number(process.env.WIKI_CACHE_TTL_DAYS ?? 30),
  failureCacheTtlDays: 1,
  minPrepareTimeBudgetMs: 3500,
  popularityThresholdForWebSearch: 0.45,
  searchIfFactsFewerThan: 2,
  searchIfHasAlbum: true,
  searchIfSoundtrackLike: true,
  searchIfLocalPlayCountAtLeast: 2,
  searchIfLastfmListenersAtLeast: 1000
};

export const CHINESE_TRACK_FALLBACK_CONFIG = {
  enabled: true,
  minLastfmSimilarTracks: 5,
  minHighConfidenceFacts: 1,
  maxResearchLatencyMsForChineseTrack: 2000,
  maxTotalPrepareLatencyMsForChineseTrack: 8000,
  allowFastFallbackForLowCoverageChineseTrack: true
};

const soundtrackHints = /original soundtrack|motion picture soundtrack|\bost\b|o\.s\.t\.|soundtrack|原声带|原聲帶|原声|原聲|主题曲|插曲|片尾曲|片头曲/i;
const chinesePattern = /[\u3400-\u9fff]/;

export async function researchSongFacts(input: {
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  album?: string;
  tags?: string[];
  lastfmListeners?: number;
  lastfmPlaycount?: number;
  localPlayCount?: number;
  artistTopTrackRank?: number;
  recommendationReason?: string;
  prepareTimeBudgetMs?: number;
  isSoundtrackLike?: boolean;
  featuredArtists?: string[];
  lastfmSimilarTrackCount?: number;
}): Promise<SongResearchResult> {
  const startedAt = performance.now();
  const cacheKey = buildCacheKey(input.rawArtist, input.rawTitle, input.album);
  const cached = getSongResearchCache(cacheKey);
  if (cached) {
    return {
      trackTitle: input.rawTitle,
      artist: input.rawArtist,
      album: input.album,
      facts: safeJson<SongFact[]>(cached.facts_json, []).slice(0, SONG_RESEARCH_CONFIG.maxFactsPassedToLLM),
      usedProviders: safeJson<string[]>(cached.provider_names_json, []),
      searched: Boolean(cached.searched),
      wikiSearched: Boolean(cached.wiki_searched),
      lastfmSearched: safeJson<string[]>(cached.provider_names_json, []).includes("lastfm"),
      cached: true,
      latencyMs: Math.round(performance.now() - startedAt),
      queries: [],
      wikiQueries: [],
      lastfmQueries: [],
      triggerReasons: ["cache_hit"],
      errors: safeJson<string[]>(cached.errors_json ?? "[]", []),
      researchStatus: "success",
      isChineseTrackLikelyLowCoverage: false
    };
  }

  const facts = buildLocalFacts(input);
  const usedProviders = ["local"];
  const errors: string[] = [];
  const triggerReasons: string[] = [];
  const popularityScore = computePopularityScore(input);
  const prepareTimeBudgetMs = input.prepareTimeBudgetMs ?? 9000;
  const isChineseTrack = chinesePattern.test(`${input.rawTitle} ${input.rawArtist}`);
  const lowCoverageChineseCandidate = CHINESE_TRACK_FALLBACK_CONFIG.enabled && isChineseTrack && (input.lastfmSimilarTrackCount ?? 0) < CHINESE_TRACK_FALLBACK_CONFIG.minLastfmSimilarTracks;
  const wikiTimeoutMs = lowCoverageChineseCandidate ? SONG_RESEARCH_CONFIG.chineseTrackWikiMaxLatencyMs : SONG_RESEARCH_CONFIG.wikiMaxLatencyMs;
  const lastfmTimeoutMs = lowCoverageChineseCandidate ? SONG_RESEARCH_CONFIG.chineseTrackLastfmInfoMaxLatencyMs : SONG_RESEARCH_CONFIG.lastfmInfoMaxLatencyMs;
  const isSoundtrack = Boolean(input.isSoundtrackLike) || soundtrackHints.test(`${input.rawTitle} ${input.album ?? ""}`);
  let wikiSearched = false;
  let lastfmSearched = false;
  let wikiQueries: string[] = [];
  let lastfmQueries: string[] = [];

  if (SONG_RESEARCH_CONFIG.enabled && SONG_RESEARCH_CONFIG.lastfmInfoEnabled && prepareTimeBudgetMs >= lastfmTimeoutMs) {
    triggerReasons.push("lastfm_track_info_enabled");
    lastfmSearched = true;
    const lastfm = await getLastfmTrackInfoFacts({
      rawTitle: input.rawTitle,
      speechTitle: input.speechTitle,
      rawArtist: input.rawArtist,
      displayArtist: input.displayArtist,
      timeoutMs: lastfmTimeoutMs
    });
    lastfmQueries = lastfm.usedVariants;
    usedProviders.push("lastfm");
    if (lastfm.ok) {
      facts.push(...lastfm.facts);
      if (lastfm.facts.length) {
        triggerReasons.push("lastfm_track_info_returned_facts");
      } else {
        triggerReasons.push("lastfm_track_info_no_facts");
      }
    } else {
      errors.push(`lastfm:${lastfm.error ?? "track_info_error"}`);
      triggerReasons.push("lastfm_track_info_failed");
    }
  }

  if (SONG_RESEARCH_CONFIG.enabled && SONG_RESEARCH_CONFIG.wikiEnabled && prepareTimeBudgetMs >= wikiTimeoutMs) {
    triggerReasons.push("wiki_enabled");
    wikiSearched = true;
    const wiki = await searchWikiSongInfo({
      rawTitle: input.rawTitle,
      speechTitle: input.speechTitle,
      rawArtist: input.rawArtist,
      displayArtist: input.displayArtist,
      album: input.album,
      isSoundtrackLike: isSoundtrack,
      featuredArtists: input.featuredArtists,
      timeoutMs: wikiTimeoutMs
    });
    wikiQueries = wiki.searchedQueries;
    usedProviders.push("wiki");
    if (wiki.ok) {
      facts.push(...wiki.facts);
      if (countHighConfidence(wiki.facts) >= SONG_RESEARCH_CONFIG.minHighConfidenceWikiFacts) {
        triggerReasons.push("wiki_returned_enough_facts");
      } else if (wiki.facts.length) {
        triggerReasons.push("wiki_returned_some_facts");
      } else {
        triggerReasons.push("wiki_no_facts");
      }
    } else {
      errors.push(`wiki:${wiki.error ?? "wiki_error"}`);
      triggerReasons.push("wiki_failed");
    }
  }

  if (lowCoverageChineseCandidate && countHighConfidence(facts) < CHINESE_TRACK_FALLBACK_CONFIG.minHighConfidenceFacts) {
    triggerReasons.push("low_coverage_chinese_fast_fallback");
  }

  const finalFacts = rankFacts(dedupeFacts(facts)).slice(0, SONG_RESEARCH_CONFIG.maxFactsPassedToLLM);
  const hasNews = finalFacts.some((fact) => fact.type === "news" || fact.type === "review");
  saveSongResearchCache({
    cacheKey,
    rawTitle: input.rawTitle,
    speechTitle: input.speechTitle,
    rawArtist: input.rawArtist,
    displayArtist: input.displayArtist,
    album: input.album,
    facts: finalFacts,
    providerNames: [...new Set(usedProviders)],
    searched: wikiSearched || lastfmSearched,
    wikiSearched,
    errors,
    expiresAt: addDays(errors.length && !finalFacts.length ? SONG_RESEARCH_CONFIG.failureCacheTtlDays : SONG_RESEARCH_CONFIG.cacheTtlDays)
  });

  return {
    trackTitle: input.rawTitle,
    artist: input.rawArtist,
    album: input.album,
    facts: finalFacts,
    usedProviders: [...new Set(usedProviders)],
    searched: wikiSearched || lastfmSearched,
    wikiSearched,
    lastfmSearched,
    cached: false,
    latencyMs: Math.round(performance.now() - startedAt),
    popularityScore,
    queries: [...lastfmQueries, ...wikiQueries],
    wikiQueries,
    lastfmQueries,
    triggerReasons: [...new Set(triggerReasons)],
    errors,
    researchStatus: lowCoverageChineseCandidate && countHighConfidence(finalFacts) < CHINESE_TRACK_FALLBACK_CONFIG.minHighConfidenceFacts ? "fallback" : finalFacts.length ? "success" : errors.length ? "fallback" : "success",
    isChineseTrackLikelyLowCoverage: lowCoverageChineseCandidate && countHighConfidence(finalFacts) < CHINESE_TRACK_FALLBACK_CONFIG.minHighConfidenceFacts
  };
}


function buildLocalFacts(input: { rawTitle: string; speechTitle: string; rawArtist: string; displayArtist: string; album?: string; recommendationReason?: string; isSoundtrackLike?: boolean }) {
  const facts: SongFact[] = [];
  if (input.album) facts.push({ type: "album", text: `当前音乐源的专辑信息是《${input.album}》。`, sourceName: "local metadata", confidence: 0.8 });
  if (input.isSoundtrackLike || soundtrackHints.test(`${input.rawTitle} ${input.album ?? ""}`)) facts.push({ type: "soundtrack", text: "标题或专辑信息显示它可能和影视原声、主题曲或插曲有关。", sourceName: "local metadata", confidence: 0.62 });
  if (input.recommendationReason) facts.push({ type: "metadata", text: input.recommendationReason.slice(0, 90), sourceName: "ranker", confidence: 0.72 });
  return facts;
}

function buildCacheKey(artist: string, title: string, album?: string) {
  return [artist, title, album ?? ""].map((value) => value.toLowerCase().replace(/\s+/g, " ").trim()).join("::");
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function addDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function countHighConfidence(facts: SongFact[]) {
  return facts.filter((fact) => fact.confidence >= 0.68).length;
}

function dedupeFacts(facts: SongFact[]) {
  const seen = new Set<string>();
  const result: SongFact[] = [];
  for (const fact of facts) {
    const key = `${fact.type}:${fact.text.toLowerCase().slice(0, 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function rankFacts(facts: SongFact[]) {
  return facts.sort((a, b) => providerPriority(a) - providerPriority(b) || b.confidence - a.confidence);
}

function providerPriority(fact: SongFact) {
  const source = fact.sourceName?.toLowerCase() ?? "";
  if (source.includes("wikipedia")) return 0;
  if (source.includes("local") || source.includes("ranker") || source.includes("last.fm")) return 1;
  return 2;
}




