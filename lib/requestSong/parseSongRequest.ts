export type ParsedSongRequest = {
  rawText: string;
  keyword: string;
  normalizedKeyword: string;
  confidence: number;
};

const REQUEST_PREFIX_PATTERNS = [
  /^\s*(?:我想听|我想聽|想听|想聽|我要听|我要聽|给我放|給我放|帮我放|幫我放|播放|来一首|來一首|点一首|點一首)\s*/i,
  /^\s*(?:please\s+)?(?:play|put\s+on|i\s+want\s+to\s+hear|i\s+wanna\s+hear)\s+/i
];

export function parseSongRequestText(text: string): ParsedSongRequest | null {
  const rawText = String(text ?? "").trim();
  if (!rawText) return null;

  let keyword = rawText
    .replace(/[“”"']/g, " ")
    .replace(/[，。！？；、]/g, " ")
    .trim();

  for (const pattern of REQUEST_PREFIX_PATTERNS) {
    keyword = keyword.replace(pattern, "").trim();
  }

  keyword = keyword
    .replace(/\s*(?:的|唱的|演唱的)\s*/g, " ")
    .replace(/\s*[-–—]+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedKeyword = normalizeRequestKeyword(keyword);
  if (!normalizedKeyword) return null;

  return {
    rawText,
    keyword,
    normalizedKeyword,
    confidence: normalizedKeyword.split(" ").length >= 2 ? 0.72 : 0.48
  };
}

export function buildSongRequestKeywords(parsed: ParsedSongRequest) {
  return unique([
    parsed.keyword,
    parsed.rawText,
    parsed.keyword.replace(/\s+/g, " "),
    parsed.keyword.replace(/\s+/g, "-"),
    parsed.normalizedKeyword
  ].map((item) => item.trim()).filter(Boolean)).slice(0, 5);
}

export function normalizeRequestKeyword(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/maroon\s*5/g, "maroon5")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
