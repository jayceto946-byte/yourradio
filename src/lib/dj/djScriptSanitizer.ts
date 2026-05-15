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
  "从你的历史记录看"
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
