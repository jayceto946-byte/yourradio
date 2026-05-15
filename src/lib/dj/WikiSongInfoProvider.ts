import type { SongFact } from "./songFacts";
import { buildWikiResearchQueries } from "./buildSongResearchQueries";
import { normalizeWikiSummaryToFacts } from "./normalizeWikiResultsToFacts";

export type WikiSearchInput = {
  rawTitle: string;
  speechTitle: string;
  rawArtist: string;
  displayArtist: string;
  album?: string;
  isSoundtrackLike?: boolean;
  featuredArtists?: string[];
  timeoutMs?: number;
};

export type WikiSongInfoOutput = {
  ok: boolean;
  facts: SongFact[];
  usedEndpoints: string[];
  searchedQueries: string[];
  latencyMs: number;
  error?: string;
};

const USER_AGENT = process.env.WIKI_USER_AGENT || "YourRadio/0.1.0 (local personal project)";

export async function searchWikiSongInfo(input: WikiSearchInput): Promise<WikiSongInfoOutput> {
  const startedAt = performance.now();
  const enabled = process.env.WIKI_SEARCH_ENABLED !== "false";
  if (!enabled) return { ok: false, facts: [], usedEndpoints: [], searchedQueries: [], latencyMs: 0, error: "disabled" };

  const timeoutMs = input.timeoutMs ?? Number(process.env.WIKI_MAX_LATENCY_MS ?? 2500);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const usedEndpoints: string[] = [];
  const searchedQueries: string[] = [];

  try {
    const facts: SongFact[] = [];
    const queries = buildWikiResearchQueries(input);
    for (const query of queries.slice(0, 4)) {
      searchedQueries.push(query);
      const zh = await searchWikipedia("zh", query, controller.signal, usedEndpoints);
      facts.push(...await summariesToFacts("zh", zh, query, input, controller.signal, usedEndpoints));
      if (highConfidenceCount(facts) >= 2) break;

      const en = await searchWikipedia("en", query, controller.signal, usedEndpoints);
      facts.push(...await summariesToFacts("en", en, query, input, controller.signal, usedEndpoints));
      if (facts.length >= 3 || highConfidenceCount(facts) >= 2) break;
    }

    facts.push(...await searchWikidataSongFacts(input));
    return {
      ok: true,
      facts: dedupeFacts(facts).slice(0, 4),
      usedEndpoints,
      searchedQueries,
      latencyMs: Math.round(performance.now() - startedAt)
    };
  } catch (cause) {
    const error = cause instanceof Error && cause.name === "AbortError" ? "timeout" : cause instanceof Error ? cause.message : "wiki_error";
    return { ok: false, facts: [], usedEndpoints, searchedQueries, latencyMs: Math.round(performance.now() - startedAt), error };
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchWikidataSongFacts(_input: WikiSearchInput): Promise<SongFact[]> {
  return [];
}

type WikiSearchItem = { title: string };

async function searchWikipedia(language: "zh" | "en", query: string, signal: AbortSignal, usedEndpoints: string[]): Promise<WikiSearchItem[]> {
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("utf8", "1");
  usedEndpoints.push(`${language}.wikipedia search`);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal, cache: "no-store" });
  if (!response.ok) return [];
  const data = await response.json().catch(() => null) as { query?: { search?: WikiSearchItem[] } } | null;
  return data?.query?.search?.slice(0, 3) ?? [];
}

async function summariesToFacts(language: "zh" | "en", items: WikiSearchItem[], query: string, input: WikiSearchInput, signal: AbortSignal, usedEndpoints: string[]) {
  const facts: SongFact[] = [];
  for (const item of items.slice(0, 2)) {
    const summary = await fetchSummary(language, item.title, signal, usedEndpoints);
    if (!summary) continue;
    facts.push(...normalizeWikiSummaryToFacts({
      pageTitle: item.title,
      extract: summary.extract,
      contentUrls: summary.content_urls,
      query,
      trackTitle: input.speechTitle || input.rawTitle,
      artist: input.displayArtist || input.rawArtist,
      album: input.album,
      language
    }));
  }
  return facts;
}

async function fetchSummary(language: "zh" | "en", title: string, signal: AbortSignal, usedEndpoints: string[]) {
  usedEndpoints.push(`${language}.wikipedia summary`);
  const response = await fetch(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
    headers: { "User-Agent": USER_AGENT },
    signal,
    cache: "no-store"
  });
  if (!response.ok) return null;
  return await response.json().catch(() => null) as { extract?: string; content_urls?: { desktop?: { page?: string } } } | null;
}

function highConfidenceCount(facts: SongFact[]) {
  return facts.filter((fact) => fact.confidence >= 0.68).length;
}

function dedupeFacts(facts: SongFact[]) {
  const seen = new Set<string>();
  const result: SongFact[] = [];
  for (const fact of facts.sort((a, b) => b.confidence - a.confidence)) {
    const key = `${fact.type}:${fact.text.toLowerCase().slice(0, 48)}`;
    if (seen.has(key) || fact.confidence < 0.4) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}
