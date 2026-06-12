import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { oidcIdentities, userSettings } from "@/db/schema";
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
 * validates the ID token. Any account on the configured provider may sign
 * in (self-hosted, family-scoped IdP): unknown subjects are registered on
 * first login, and the instance settings row is bootstrapped if missing,
 * so a fresh deployment never requires the password /setup flow.
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
  let displayName: string | undefined;
  let email: string | undefined;
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
    displayName =
      (idClaims.name as string | undefined) ||
      (idClaims.preferred_username as string | undefined);
    email = idClaims.email as string | undefined;
  } catch (error) {
    console.error("OIDC callback validation failed:", error);
    return clearTxnCookie(loginRedirect(request, "oidc_failed"));
  }

  try {
    const issuer = getOidcIssuer();

    // Register or refresh this identity (signup happens implicitly here).
    const existing = await db
      .select()
      .from(oidcIdentities)
      .where(
        and(eq(oidcIdentities.issuer, issuer), eq(oidcIdentities.subject, subject))
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(oidcIdentities).values({
        issuer,
        subject,
        displayName: displayName ?? null,
        email: email ?? null,
      });
    } else {
      await db
        .update(oidcIdentities)
        .set({
          displayName: displayName ?? existing[0].displayName,
          email: email ?? existing[0].email,
          lastLoginAt: new Date(),
        })
        .where(eq(oidcIdentities.id, existing[0].id));
    }

    // Bootstrap the instance settings row on first-ever login so OIDC-only
    // deployments skip the password /setup flow entirely.
    const settings = await db.select().from(userSettings).limit(1);
    if (settings.length === 0) {
      await db.insert(userSettings).values({
        passwordHash: null,
        displayName: displayName ?? null,
      });
    }

    const token = await createSession({ sub: subject, name: displayName });
    await setSessionCookie(token);
    return clearTxnCookie(
      NextResponse.redirect(appUrl("/dashboard", request.url))
    );
  } catch (error) {
    console.error("OIDC callback failed:", error);
    return clearTxnCookie(loginRedirect(request, "oidc_failed"));
  }
}
