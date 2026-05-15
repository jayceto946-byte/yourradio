import { NextResponse, type NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  if (process.env.ENABLE_DEBUG_ROUTES !== "true") {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/debug/:path*"]
};
