import { type NextRequest, NextResponse } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/session";

// Cron and MCP check their own bearer tokens
const PUBLIC = ["/login", "/api/cron/", "/api/mcp"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (
    PUBLIC.some((p) => pathname.startsWith(p)) ||
    isValidSession(request.cookies.get(SESSION_COOKIE)?.value)
  ) {
    return NextResponse.next();
  }
  const url = new URL("/login", request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
