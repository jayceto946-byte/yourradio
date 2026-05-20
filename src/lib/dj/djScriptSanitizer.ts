export const BANNED_DJ_INTERNAL_PHRASES = [
  "歌单里拿到了线索",
  "歌单线索",
  "推荐线索",
  "候选池",
  "候选歌曲",
  "Ranker",
  "Last.fm",
  "Wiki",
  "API",
  "metadata",
  "打分",
  "权重",
  "模型认为",
  "系统认为",
  "我检索到",
  "我搜索到",
  "根据数据",
  "根据算法",
  "你的播放记录显示",
  "从你的历史记录看",
  "\u8d44\u6599\u4e0d\u8db3",
  "\u8d44\u6599\u4e0d\u591a",
  "\u8d44\u6599\u70b9\u5230\u4e3a\u6b62",
  "\u4e0d\u7528\u8bb2\u5f97\u592a\u6ee1",
  "\u4e0d\u7528\u8bf4\u5f97\u592a\u6ee1",
  "\u4e0d\u7528\u8bf4\u6ee1",
  "\u6839\u636e\u7ebf\u7d22",
  "\u8d44\u6599\u5361",
  "\u7f13\u5b58",
  "Tavily"
];

export function detectBannedDjInternalPhrase(text: string) {
  const normalized = text.toLowerCase();
  return BANNED_DJ_INTERNAL_PHRASES.find((phrase) => normalized.includes(phrase.toLowerCase())) ?? null;
}

export function sanitizeRecommendationReason(value?: string) {
  if (!value) return "";
  let text = value;
  for (const phrase of BANNED_DJ_INTERNAL_PHRASES) {
    text = text.replace(new RegExp(escapeRegExp(phrase), "ig"), "");
  }
  return text
    .replace(/lastfm|last\.fm|ranker|wiki|api|metadata/ig, "")
    .replace(/\s+/g, " ")
    .replace(/[，,。；;：:]{2,}/g, "，")
    .trim()
    .slice(0, 90);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
