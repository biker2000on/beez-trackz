"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";

import { login, type AuthFormState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const OIDC_ERROR_MESSAGES: Record<string, string> = {
  oidc_state: "Sign-in session expired. Please try again.",
  oidc_cancelled: "Sign-in was cancelled.",
  oidc_failed: "SSO sign-in failed. Please try again.",
  oidc_unavailable: "SSO provider is unavailable right now.",
  oidc_not_linked: "This SSO account is not linked to this app.",
};

export function LoginForm({
  displayName,
  oidcProviderName,
  oidcError,
}: {
  displayName: string | null;
  oidcProviderName?: string | null;
  oidcError?: string | null;
}) {
  const [state, formAction, isPending] = useServerActionForm<AuthFormState>(
    login,
    {}
  );

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          Welcome back{displayName ? `, ${displayName}` : ""}
        </CardTitle>
        <CardDescription>
          Enter your password to access Beez Trackz.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={formAction} className="space-y-4">
          {state.error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="Enter your password"
              required
            />
          </div>

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Signing in..." : "Sign In"}
          </Button>
        </form>

        {oidcProviderName && (
          <div className="mt-4 space-y-3">
            {oidcError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {OIDC_ERROR_MESSAGES[oidcError] ?? "SSO sign-in failed."}
              </div>
            )}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>
            <Button variant="outline" className="w-full" asChild>
              <a href="/api/auth/oidc/login">
                Sign in with {oidcProviderName}
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
