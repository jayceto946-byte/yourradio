import { recordFeedback } from "@/lib/radioState";
import type { FeedbackAction, RadioNextResponse } from "@/lib/types";
import { NextResponse } from "next/server";

type FeedbackBody = {
  action?: FeedbackAction;
  item?: RadioNextResponse;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FeedbackBody;

    if (!body.action || !body.item) {
      return NextResponse.json({ error: "缺少 action 或 item" }, { status: 400 });
    }

    const state = await recordFeedback(body.action, body.item);
    return NextResponse.json({ ok: true, state });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "反馈写入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
