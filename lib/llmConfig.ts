export type LlmProvider = "openai_compatible" | "deepseek";

function readEnv(name: string) {
  return process.env[name]?.trim();
}

function normalizeProvider(value?: string): LlmProvider {
  return value === "deepseek" ? "deepseek" : "openai_compatible";
}

export const LLM_CONFIG = {
  provider: normalizeProvider(readEnv("LLM_PROVIDER")),
  apiUrl: readEnv("LLM_API_URL") || readEnv("DEEPSEEK_API_URL") || "https://api.deepseek.com/chat/completions",
  apiKey: readEnv("LLM_API_KEY") || readEnv("DEEPSEEK_API_KEY"),
  model: readEnv("LLM_MODEL") || readEnv("DEEPSEEK_MODEL") || "deepseek-v4-pro"
};

export function buildLlmRequestBody<T extends Record<string, unknown>>(
  base: T,
  deepseekExtras?: Record<string, unknown>
): T & Record<string, unknown> {
  return LLM_CONFIG.provider === "deepseek" && deepseekExtras
    ? { ...base, ...deepseekExtras }
    : base;
}
