export type TtsGenerateInput = {
  text: string;
  language?: string;
  cacheKey?: string;
  timeoutMs?: number;
  budgetMs?: number;
  priority?: "normal" | "low";
};

export type TtsGenerateOutput = {
  ok: boolean;
  provider: string;
  audioUrl?: string;
  audioPath?: string;
  format?: "wav" | "mp3";
  cached: boolean;
  latencyMs: number;
  error?: string;
};

export interface TtsProvider {
  readonly name: string;
  generate(input: TtsGenerateInput): Promise<TtsGenerateOutput>;
  healthCheck?(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }>;
}



