export type LlmCacheStat = {
  task: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  promptTokens: number;
  completionTokens: number;
  hitRate: number;
  createdAt: string;
};

const MAX_STATS = 50;
const stats: LlmCacheStat[] = [];

export function recordLlmCacheStats(input: {
  task: string;
  usage?: {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}) {
  const cacheHitTokens = input.usage?.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = input.usage?.prompt_cache_miss_tokens ?? 0;
  const totalCacheTokens = cacheHitTokens + cacheMissTokens;
  const item: LlmCacheStat = {
    task: input.task,
    cacheHitTokens,
    cacheMissTokens,
    promptTokens: input.usage?.prompt_tokens ?? 0,
    completionTokens: input.usage?.completion_tokens ?? 0,
    hitRate: totalCacheTokens ? Number((cacheHitTokens / totalCacheTokens).toFixed(3)) : 0,
    createdAt: new Date().toISOString()
  };
  stats.unshift(item);
  stats.splice(MAX_STATS);
  if (process.env.NODE_ENV !== "production") {
    console.log("[llm-cache]", JSON.stringify(item));
  }
}

export function getRecentLlmCacheStats(limit = MAX_STATS) {
  return stats.slice(0, limit);
}
