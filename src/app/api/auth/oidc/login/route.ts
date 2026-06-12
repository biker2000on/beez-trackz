import { NextRequest, NextResponse } from "next/server";
import {
  appUrl,
  isOidcConfigured,
  getOidcConfiguration,
  getRedirectUri,
  sealOidcTransaction,
  oidcClient,
  OIDC_TXN_COOKIE,
  OIDC_TXN_TTL_SECONDS,
} from "@/lib/oidc";

/**
 * GET /api/auth/oidc/login
 *
 * Starts the OIDC authorization code flow (PKCE S256 + state + nonce).
 * Returns 404 when OIDC is not configured (the login page uses this to
 * decide whether to show the SSO button).
 */
export async function GET(request: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.json(
      { error: "OIDC is not configured" },
      { status: 404 }
    );
  }

  try {
    const config = await getOidcConfiguration();

    const codeVerifier = oidcClient.randomPKCECodeVerifier();
    const codeChallenge = await oidcClient.calculatePKCECodeChallenge(
      codeVerifier
    );
    const state = oidcClient.randomState();
    const nonce = oidcClient.randomNonce();

    const authorizationUrl = oidcClient.buildAuthorizationUrl(config, {
      redirect_uri: getRedirectUri(request.nextUrl.origin),
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const sealed = await sealOidcTransaction({ state, nonce, codeVerifier });

    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OIDC_TXN_COOKIE, sealed, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: OIDC_TXN_TTL_SECONDS,
      path: "/",
    });
    return response;
  } catch (error) {
    console.error("OIDC login initiation failed:", error);
    return NextResponse.redirect(
      appUrl("/login?error=oidc_unavailable", request.url)
    );
  }
}
