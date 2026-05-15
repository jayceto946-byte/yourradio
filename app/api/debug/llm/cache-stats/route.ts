import { getRecentLlmCacheStats } from "@/src/lib/llm/cacheStats";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const items = getRecentLlmCacheStats(limit);
  const totals = items.reduce((acc, item) => {
    acc.cacheHitTokens += item.cacheHitTokens;
    acc.cacheMissTokens += item.cacheMissTokens;
    acc.promptTokens += item.promptTokens;
    acc.completionTokens += item.completionTokens;
    return acc;
  }, { cacheHitTokens: 0, cacheMissTokens: 0, promptTokens: 0, completionTokens: 0 });
  const cacheTotal = totals.cacheHitTokens + totals.cacheMissTokens;
  return NextResponse.json({
    items,
    summary: {
      ...totals,
      hitRate: cacheTotal ? Number((totals.cacheHitTokens / cacheTotal).toFixed(3)) : 0
    }
  });
}
