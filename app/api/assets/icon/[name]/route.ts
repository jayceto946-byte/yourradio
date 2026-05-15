import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_ICONS = new Set(["heart", "ellipsis"]);

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!ALLOWED_ICONS.has(name)) {
    return NextResponse.json({ ok: false, error: "icon_not_found" }, { status: 404 });
  }

  const fileName = name === "heart" ? "new_heart.svg" : `${name}.svg`;
  const iconPath = path.join(process.cwd(), "data", fileName);
  if (!existsSync(iconPath)) {
    return NextResponse.json({ ok: false, error: "icon_not_found" }, { status: 404 });
  }

  const stream = createReadStream(iconPath);
  return new Response(stream as unknown as BodyInit, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate"
    }
  });
}
