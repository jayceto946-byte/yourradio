import type { SongFact } from "./songFacts";

const lyricsPattern = /lyrics|歌词|歌詞/i;
const disambiguationPattern = /disambiguation|消歧义|消歧義/i;
const soundtrackPattern = /soundtrack|ost|原声|原聲|主题曲|插曲|片尾曲|片头曲|电影|電影/i;
const releasePattern = /release|released|发行|發行|专辑|專輯|album/i;

export function normalizeWikiSummaryToFacts(input: {
  pageTitle: string;
  extract?: string;
  contentUrls?: { desktop?: { page?: string } };
  query: string;
  trackTitle: string;
  artist: string;
  album?: string;
  language?: "zh" | "en";
}): SongFact[] {
  const extract = (input.extract ?? "").replace(/\s+/g, " ").trim();
  if (!extract || lyricsPattern.test(extract) || disambiguationPattern.test(`${input.pageTitle} ${extract}`)) return [];

  const relevance = scoreRelevance({ ...input, extract });
  if (relevance < 0.4) return [];

  const type = inferWikiFactType(input.pageTitle, extract, input.album);
  return [{
    type,
    text: shorten(extract),
    sourceName: input.language === "en" ? "Wikipedia en" : "Wikipedia zh",
    sourceUrl: input.contentUrls?.desktop?.page,
    confidence: Math.min(0.9, relevance)
  }];
}

function scoreRelevance(input: { pageTitle: string; extract: string; trackTitle: string; artist: string; album?: string }) {
  const page = normalize(input.pageTitle);
  const text = normalize(`${input.pageTitle} ${input.extract}`);
  const titleTokens = importantTokens(input.trackTitle);
  const artistTokens = importantTokens(input.artist);
  const albumTokens = importantTokens(input.album ?? "");
  const titleHit = titleTokens.some((token) => page.includes(token) || text.includes(token));
  const artistHit = artistTokens.some((token) => text.includes(token));
  const albumHit = albumTokens.some((token) => page.includes(token) || text.includes(token));

  if (titleHit && artistHit) return 0.86;
  if (titleHit && (albumHit || soundtrackPattern.test(text))) return 0.74;
  if (albumHit && artistHit) return 0.66;
  if (artistTokens.some((token) => page === token || page.includes(token)) && !titleHit && !albumHit) return 0.42;
  return 0.2;
}

function inferWikiFactType(pageTitle: string, extract: string, album?: string): SongFact["type"] {
  const value = `${pageTitle} ${extract} ${album ?? ""}`;
  if (soundtrackPattern.test(value)) return "soundtrack";
  if (releasePattern.test(value)) return "release_date";
  if (album && normalize(value).includes(normalize(album))) return "album";
  return "background";
}

function importantTokens(value: string) {
  const normalized = normalize(value);
  const compact = normalized.replace(/\s+/g, "");
  const parts = normalized.split(/\s+|,|，|、|和|&/).filter((part) => part.length >= 2);
  return [compact, ...parts].filter((part) => part.length >= 2).slice(0, 6);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[《》"“”'’‘()（）\[\]【】:：\-–—]/g, " ").replace(/\s+/g, " ").trim();
}

function shorten(value: string) {
  const cleaned = value.replace(/\([^)]*lyrics[^)]*\)/ig, "").trim();
  return cleaned.length > 96 ? `${cleaned.slice(0, 94)}…` : cleaned;
}
