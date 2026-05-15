export type TrackSpeechFormatInput = {
  title: string;
  artist: string;
  album?: string;
};

export type TrackSpeechFormatResult = {
  speechTitle: string;
  displayArtist: string;
  featuredArtists: string[];
  removedTitleParts: string[];
  isSoundtrackLike: boolean;
};

const soundtrackPatterns = [
  /\s*[-–—:]\s*(?:from\s+)?(?:the\s+)?(?:original\s+)?(?:motion\s+picture\s+)?soundtrack.*$/i,
  /\s*[-–—:]\s*original\s+(?:motion\s+picture\s+)?soundtrack.*$/i,
  /\s*[-–—:]\s*ost\b.*$/i,
  /\s*[-–—:]\s*o\.s\.t\..*$/i,
  /\s*[-–—:]\s*soundtrack\s+version.*$/i,
  /\s*[-–—:]\s*original\s+score.*$/i,
  /\s*[-–—:]\s*(?:movie|tv)\s+version.*$/i,
  /\s*\((?:from\s+)?["“][^"”]+["”]\s*(?:original\s+)?(?:motion\s+picture\s+)?soundtrack[^)]*\)/i,
  /\s*\((?:电影|影视|电视剧|剧集)?[^)]*(?:原声带|原声|主题曲|插曲|片尾曲|片头曲)[^)]*\)/i,
  /\s*（(?:电影|影视|电视剧|剧集)?[^）]*(?:原声带|原声|主题曲|插曲|片尾曲|片头曲)[^）]*）/i,
  /\s*[-–—:]\s*(?:电影|影视|电视剧|剧集)?[^-–—]*(?:原声带|原声|主题曲|插曲|片尾曲|片头曲).*$/i
];

const featPatterns = [
  /\s*[\(（]\s*(?:feat\.?|ft\.?|featuring|with|合作|合唱)\s+([^\)）]+)[\)）]/i,
  /\s*[-–—:]\s*(?:feat\.?|ft\.?|featuring|with|合作|合唱)\s+(.+)$/i,
  /\s+(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i
];

export function formatTrackForSpeech(input: TrackSpeechFormatInput): TrackSpeechFormatResult {
  const removedTitleParts: string[] = [];
  const featuredArtists: string[] = [];
  let speechTitle = normalizeSpaces(input.title);

  for (const pattern of featPatterns) {
    const match = speechTitle.match(pattern);
    if (!match) continue;
    removedTitleParts.push(match[0].trim());
    featuredArtists.push(...splitArtists(match[1]));
    speechTitle = speechTitle.replace(pattern, "").trim();
  }

  for (const pattern of soundtrackPatterns) {
    const match = speechTitle.match(pattern);
    if (!match) continue;
    removedTitleParts.push(match[0].trim());
    speechTitle = speechTitle.replace(pattern, "").trim();
  }

  speechTitle = cleanupTitlePunctuation(speechTitle) || normalizeSpaces(input.title);
  const displayArtist = mergeDisplayArtists(input.artist, featuredArtists);

  return {
    speechTitle,
    displayArtist,
    featuredArtists: uniqueArtists(featuredArtists),
    removedTitleParts,
    isSoundtrackLike: removedTitleParts.some((part) => /soundtrack|ost|o\.s\.t|原声|原聲|主题曲|插曲|片尾曲|片头曲/i.test(part)) || /soundtrack|ost|o\.s\.t|原声|原聲|主题曲|插曲|片尾曲|片头曲/i.test(input.album ?? "")
  };
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanupTitlePunctuation(value: string) {
  return normalizeSpaces(value)
    .replace(/[\s\-–—:]+$/g, "")
    .replace(/^[\s\-–—:]+/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .trim();
}

function splitArtists(value: string) {
  return value
    .split(/,|，|、|&| and | 和 | with | feat\.?|ft\.?|featuring/i)
    .map((artist) => cleanupTitlePunctuation(artist))
    .filter(Boolean);
}

function mergeDisplayArtists(artist: string, featured: string[]) {
  const base = normalizeSpaces(artist);
  const additions = uniqueArtists(featured).filter((candidate) => !artistIncludes(base, candidate));
  if (!additions.length) return base;
  return `${base} 和 ${additions.join("、")}`;
}

function artistIncludes(source: string, artist: string) {
  return normalizeArtist(source).includes(normalizeArtist(artist));
}

function normalizeArtist(value: string) {
  return value.toLowerCase().replace(/[\s,，、&和]+/g, "");
}

function uniqueArtists(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeArtist(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}



