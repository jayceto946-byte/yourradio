import { loadRollingQueueSnapshot, refillRollingQueue } from "@/src/lib/player/rollingQueue/rollingQueueStore";
import { ROLLING_QUEUE_TARGETS } from "@/src/lib/player/rollingQueue/queueTypes";
import { NextResponse } from "next/server";

export async function GET() {
  const snapshot = await loadRollingQueueSnapshot();
  return NextResponse.json({
    ok: true,
    queue: snapshot.queue.map((slot) => ({
      id: slot.id,
      index: slot.index,
      status: slot.status,
      track: slot.item ? `${slot.item.track.title} - ${slot.item.track.artist}` : null,
      hasScript: Boolean(slot.item?.djLine),
      hasTts: Boolean(slot.item?.ttsUrl),
      locked: slot.locked,
      stale: slot.stale,
      failureReason: slot.failureReason
    })),
    targets: ROLLING_QUEUE_TARGETS,
    refillRunning: snapshot.refillRunning,
    workers: snapshot.workers,
    updatedAt: snapshot.updatedAt
  });
}
