import { NextResponse } from "next/server";
import { recordRuntimeEvent } from "@/lib/runtimeLog";
import { refillRollingQueue, saveWarmupPackageFromQueue } from "@/src/lib/player/rollingQueue/rollingQueueStore";

export async function POST() {
  const startedAt = performance.now();
  const pkg = await saveWarmupPackageFromQueue("player_stop");

  if (pkg) {
    void recordRuntimeEvent({
      step: "player.stop",
      status: "success",
      durationMs: Math.round(performance.now() - startedAt),
      context: { warmupSaved: true, track: `${pkg.item.track.title} - ${pkg.item.track.artist}`, hasTts: Boolean(pkg.item.ttsUrl) }
    });
    return NextResponse.json({ ok: true, warmupSaved: true, package: summarizeWarmup(pkg) });
  }

  void refillRollingQueue({ allowTts: true })
    .then(() => saveWarmupPackageFromQueue("player_stop_after_refill"))
    .catch((cause) => {
      void recordRuntimeEvent({
        step: "player.stop.warmup_refill",
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause)
      });
    });

  void recordRuntimeEvent({
    step: "player.stop",
    status: "info",
    durationMs: Math.round(performance.now() - startedAt),
    context: { warmupSaved: false, refillStarted: true }
  });
  return NextResponse.json({ ok: true, warmupSaved: false, refillStarted: true, message: "No script_ready queue item yet; background refill started." });
}

function summarizeWarmup(pkg: Awaited<ReturnType<typeof saveWarmupPackageFromQueue>>) {
  if (!pkg) return null;
  return {
    id: pkg.id,
    track: `${pkg.item.track.title} - ${pkg.item.track.artist}`,
    hasScript: Boolean(pkg.item.djLine),
    hasTts: Boolean(pkg.item.ttsUrl),
    expiresAt: pkg.expiresAt
  };
}
