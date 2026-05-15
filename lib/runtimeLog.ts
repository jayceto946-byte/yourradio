import { createReadStream } from "node:fs";
import { mkdir, appendFile, stat } from "node:fs/promises";
import path from "node:path";

export type RuntimeLogStatus = "started" | "success" | "error" | "info";

export type RuntimeLogEntry = {
  id?: string;
  step: string;
  status: RuntimeLogStatus;
  durationMs?: number;
  message?: string;
  error?: string;
  context?: Record<string, unknown>;
  createdAt?: string;
};

const LOG_DIR = path.join(process.cwd(), "data", "logs");
const LOG_PATH = path.join(LOG_DIR, "runtime-events.jsonl");
const MAX_CONTEXT_CHARS = 3000;

export async function recordRuntimeEvent(entry: RuntimeLogEntry) {
  const safeEntry: RuntimeLogEntry = {
    ...entry,
    id: entry.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    context: trimContext(entry.context)
  };

  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(safeEntry)}\n`, "utf8");
  } catch (cause) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[runtime-log] failed to write log", cause);
    }
  }
}

export async function measureRuntimeStep<T>(step: string, context: Record<string, unknown> | undefined, task: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  await recordRuntimeEvent({ step, status: "started", context });
  try {
    const result = await task();
    await recordRuntimeEvent({ step, status: "success", durationMs: Math.round(performance.now() - startedAt), context });
    return result;
  } catch (cause) {
    await recordRuntimeEvent({
      step,
      status: "error",
      durationMs: Math.round(performance.now() - startedAt),
      error: cause instanceof Error ? cause.message : String(cause),
      context
    });
    throw cause;
  }
}

export async function readRecentRuntimeEvents(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, limit));
  try {
    const info = await stat(LOG_PATH);
    const maxBytes = Math.max(64 * 1024, safeLimit * 4096);
    const start = Math.max(0, info.size - maxBytes);
    const raw = await readFileSlice(LOG_PATH, start, info.size);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const completeLines = start > 0 ? lines.slice(1) : lines;
    return completeLines
      .slice(-safeLimit)
      .map((line) => {
        try {
          return JSON.parse(line) as RuntimeLogEntry;
        } catch {
          return { step: "runtime-log", status: "error", error: "invalid_jsonl_line", message: line.slice(0, 1000) } satisfies RuntimeLogEntry;
        }
      });
  } catch {
    return [];
  }
}

function readFileSlice(filePath: string, start: number, end: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: Math.max(start, end - 1) });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function trimContext(context: Record<string, unknown> | undefined) {
  if (!context) return undefined;
  const raw = JSON.stringify(context);
  if (raw.length <= MAX_CONTEXT_CHARS) return context;
  return { truncated: true, preview: raw.slice(0, MAX_CONTEXT_CHARS) };
}


