import { recordRuntimeEvent } from "../../../lib/runtimeLog";

type QueueTask<T> = () => Promise<T>;
type TtsQueuePriority = "normal" | "low";

type PendingTask<T> = {
  id: string;
  task: QueueTask<T>;
  budgetMs: number;
  priority: TtsQueuePriority;
  queuedAt: number;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
};

const pendingTasks: PendingTask<unknown>[] = [];
let running = false;
let activePriority: TtsQueuePriority | null = null;

export function enqueueQwenTts<T>(task: QueueTask<T>, budgetMs: number, priority: TtsQueuePriority = "normal"): Promise<T> {
  const queuedAt = performance.now();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise<T>((resolve, reject) => {
    pendingTasks.push({ id, task: task as QueueTask<unknown>, budgetMs, priority, queuedAt, resolve: resolve as (value: unknown) => void, reject });
    void recordRuntimeEvent({ step: "tts.queue", status: "started", context: { pendingCount: pendingTasks.length, budgetMs, priority } });
    scheduleDrain();
  });
}

export function getQwenTtsQueueStatus() {
  return {
    pendingCount: pendingTasks.length,
    running,
    activePriority,
    normalPending: pendingTasks.filter((task) => task.priority === "normal").length,
    lowPending: pendingTasks.filter((task) => task.priority === "low").length
  };
}

function scheduleDrain() {
  if (running) return;
  void drainQueue();
}

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    while (pendingTasks.length) {
      const task = pickNextTask();
      activePriority = task.priority;
      const waitedMs = Math.round(performance.now() - task.queuedAt);
      if (waitedMs > task.budgetMs) {
        void recordRuntimeEvent({ step: "tts.queue", status: "error", durationMs: waitedMs, error: "tts_queue_budget_exceeded", context: { pendingCount: pendingTasks.length, budgetMs: task.budgetMs, priority: task.priority } });
        task.reject(new Error("tts_queue_budget_exceeded"));
        continue;
      }

      void recordRuntimeEvent({ step: "tts.queue", status: "info", durationMs: waitedMs, message: "dequeued", context: { pendingCount: pendingTasks.length + 1, budgetMs: task.budgetMs, priority: task.priority } });
      try {
        const value = await task.task();
        task.resolve(value);
        void recordRuntimeEvent({ step: "tts.queue", status: "success", durationMs: Math.round(performance.now() - task.queuedAt), context: { pendingCount: pendingTasks.length, budgetMs: task.budgetMs, priority: task.priority } });
      } catch (cause) {
        task.reject(cause);
        void recordRuntimeEvent({ step: "tts.queue", status: "error", durationMs: Math.round(performance.now() - task.queuedAt), error: cause instanceof Error ? cause.message : String(cause), context: { pendingCount: pendingTasks.length, budgetMs: task.budgetMs, priority: task.priority } });
      }
    }
  } finally {
    activePriority = null;
    running = false;
    if (pendingTasks.length) scheduleDrain();
  }
}

function pickNextTask() {
  const normalIndex = pendingTasks.findIndex((task) => task.priority === "normal");
  const index = normalIndex >= 0 ? normalIndex : 0;
  const [task] = pendingTasks.splice(index, 1);
  return task;
}
