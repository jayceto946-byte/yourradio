import { getLastDjScriptDebug } from "@/lib/dj";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(getLastDjScriptDebug() ?? { ok: false, message: "No DJ script generated yet." });
}
