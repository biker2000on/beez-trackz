import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getSessionSecret } from "./lib/constants";

const PUBLIC_PATHS = ["/login", "/setup", "/_next", "/favicon.ico"];

// /api/mcp handles its own auth (Bearer token or session cookie) and exposes
// its own login route; /api/auth/oidc implements the OIDC redirect flow for
// logged-out users. Everything else under /api requires the session cookie.
const SELF_AUTHENTICATED_API_PATHS = ["/api/mcp", "/api/auth/oidc"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  if (SELF_AUTHENTICATED_API_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const isApiRoute = pathname.startsWith("/api");

  // Check session
  const token = request.cookies.get("session")?.value;
  if (!token) {
    if (isApiRoute) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    await jwtVerify(token, getSessionSecret());
    return NextResponse.next();
  } catch {
    if (isApiRoute) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = {
  // Public PWA assets (manifest, service worker, icons) must stay reachable
  // without a session — the OS fetches them while logged out during install.
  // Listed explicitly so /api/photos/*.jpg stays auth-protected.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon-32.png|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|icon-maskable-512.png|apple-icon.png).*)",
  ],
};
