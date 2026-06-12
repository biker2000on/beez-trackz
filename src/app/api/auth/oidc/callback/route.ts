import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { createSession, setSessionCookie } from "@/lib/session";
import {
  appUrl,
  isOidcConfigured,
  getOidcConfiguration,
  getOidcIssuer,
  getRedirectUri,
  unsealOidcTransaction,
  oidcClient,
  OIDC_TXN_COOKIE,
} from "@/lib/oidc";

function loginRedirect(request: NextRequest, error: string) {
  const url = appUrl("/login", request.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

/**
 * GET /api/auth/oidc/callback
 *
 * Completes the authorization code flow: verifies state/nonce/PKCE and
 * validates the ID token. Single-user model: the first successful OIDC
 * login links the provider identity to the lone user_settings row;
 * subsequent logins must present the same issuer + subject.
 */
export async function GET(request: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.json(
      { error: "OIDC is not configured" },
      { status: 404 }
    );
  }

  // --- Recover and clear the transaction cookie ---
  const sealed = request.cookies.get(OIDC_TXN_COOKIE)?.value;
  const txn = sealed ? await unsealOidcTransaction(sealed) : null;

  const clearTxnCookie = (response: NextResponse) => {
    response.cookies.set(OIDC_TXN_COOKIE, "", { maxAge: 0, path: "/" });
    return response;
  };

  if (!txn) {
    return clearTxnCookie(loginRedirect(request, "oidc_state"));
  }

  // Provider-reported errors (user cancelled, etc.)
  if (request.nextUrl.searchParams.get("error")) {
    return clearTxnCookie(loginRedirect(request, "oidc_cancelled"));
  }

  let subject: string;
  try {
    const config = await getOidcConfiguration();

    // Reconstruct the callback URL on the registered redirect URI so the
    // library's redirect_uri check passes even behind a reverse proxy.
    const currentUrl = new URL(getRedirectUri(request.nextUrl.origin));
    currentUrl.search = request.nextUrl.search;

    const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: txn.codeVerifier,
      expectedState: txn.state,
      expectedNonce: txn.nonce,
      idTokenExpected: true,
    });

    const idClaims = tokens.claims();
    if (!idClaims?.sub) {
      throw new Error("ID token missing subject");
    }
    subject = idClaims.sub;
  } catch (error) {
    console.error("OIDC callback validation failed:", error);
    return clearTxnCookie(loginRedirect(request, "oidc_failed"));
  }

  try {
    const issuer = getOidcIssuer();
    const users = await db.select().from(userSettings).limit(1);
    if (users.length === 0) {
      // No local account yet — run password setup first.
      return clearTxnCookie(
        NextResponse.redirect(appUrl("/setup", request.url))
      );
    }
    const user = users[0];

    if (!user.oidcSubject) {
      // First OIDC login: link this identity to the single local user.
      await db
        .update(userSettings)
        .set({ oidcSubject: subject, oidcIssuer: issuer, updatedAt: new Date() })
        .where(eq(userSettings.id, user.id));
    } else if (user.oidcSubject !== subject || user.oidcIssuer !== issuer) {
      console.error("OIDC subject mismatch — refusing login");
      return clearTxnCookie(loginRedirect(request, "oidc_not_linked"));
    }

    const token = await createSession();
    await setSessionCookie(token);
    return clearTxnCookie(
      NextResponse.redirect(appUrl("/dashboard", request.url))
    );
  } catch (error) {
    console.error("OIDC callback failed:", error);
    return clearTxnCookie(loginRedirect(request, "oidc_failed"));
  }
}
