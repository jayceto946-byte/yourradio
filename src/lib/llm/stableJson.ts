type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const OMIT_KEYS = new Set([
  "runId",
  "latencyMs",
  "createdAt",
  "updatedAt",
  "cacheHit",
  "debugDump",
  "raw",
  "raw_json",
  "rawJson",
  "providerRawResponse"
]);

export function stableJsonStringify(value: unknown, space = 0): string {
  return JSON.stringify(normalizeForStableJson(value), null, space);
}

export function normalizeForStableJson(value: unknown): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number(value.toFixed(3));
  }

  if (typeof value === "string" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeForStableJson(item))
      .filter((item): item is JsonValue => item !== undefined);
    return items;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (OMIT_KEYS.has(key)) continue;
      const normalized = normalizeForStableJson(record[key]);
      if (normalized === undefined) continue;
      if (Array.isArray(normalized) && normalized.length === 0) continue;
      if (normalized && typeof normalized === "object" && !Array.isArray(normalized) && Object.keys(normalized).length === 0) continue;
      result[key] = normalized;
    }
    return result;
  }

  return undefined;
}

