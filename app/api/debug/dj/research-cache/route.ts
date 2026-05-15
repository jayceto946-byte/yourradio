import { listSongResearchCache } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const rows = listSongResearchCache(limit).map((row) => ({
    ...row,
    facts: JSON.parse(row.facts_json),
    providerNames: JSON.parse(row.provider_names_json),
    errors: row.errors_json ? JSON.parse(row.errors_json) : []
  }));
  return NextResponse.json({ items: rows });
}
