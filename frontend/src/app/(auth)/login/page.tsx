"use client";

import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, LogIn } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { api, ApiError, type AuthStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

const loginSchema = z.object({
  email: z.string().trim(),
  password: z.string().min(1, "Enter your password"),
});

type LoginValues = z.infer<typeof loginSchema>;

const OIDC_ERROR_MESSAGES: Record<string, string> = {
  oidc_state:
    "Your sign-in session expired or was invalid. Please try again.",
  oidc_cancelled: "Single sign-on was cancelled.",
  oidc_failed: "Single sign-on failed. Please try again or use your password.",
  oidc_unavailable:
    "The single sign-on provider is unavailable right now. Please try again later.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const oidcErrorCode = searchParams.get("error");
  const oidcError = oidcErrorCode
    ? (OIDC_ERROR_MESSAGES[oidcErrorCode] ??
      "Sign-in failed. Please try again.")
    : null;

  const status = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api.get<AuthStatus>("/auth/status"),
    staleTime: 0,
  });

  React.useEffect(() => {
    if (!status.data) return;
    if (status.data.authenticated) {
      router.replace("/dashboard");
    } else if (!status.data.setupComplete && !status.data.oidcEnabled) {
      router.replace("/setup");
    }
  }, [status.data, router]);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    setServerError(null);
    try {
      if (showSso && !values.email) {
        form.setError("email", {
          message: "Enter your email or username",
        });
        return;
      }
      await api.post<{ success: boolean }>("/auth/login", {
        ...(values.email ? { email: values.email } : {}),
        password: values.password,
      });
      router.replace("/dashboard");
    } catch (error) {
      if (error instanceof ApiError) {
        const body = error.body as { setupRequired?: boolean } | null;
        if (error.status === 412 && body?.setupRequired) {
          router.replace("/setup");
          return;
        }
        setServerError(
          error.status === 401
            ? error.message
            : "Something went wrong signing you in. Please try again.",
        );
      } else {
        setServerError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
    }
  }

  const showSso = status.data?.oidcEnabled === true;
  const showPassword = status.data ? status.data.passwordLogin : true;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your apiary.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {oidcError && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {oidcError}
          </p>
        )}
        {status.isLoading ? (
          <div className="grid gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            {showPassword && (
              <ShortcutForm
                onSubmit={form.handleSubmit(onSubmit)}
                className="grid gap-4"
                noValidate
              >
                <div className="grid gap-2">
                  <Label htmlFor="email">Email or username</Label>
                  <Input
                    id="email"
                    type="text"
                    autoComplete="username"
                    autoFocus={showSso}
                    placeholder={
                      showSso ? "SSO email or the username you chose" : undefined
                    }
                    aria-invalid={
                      form.formState.errors.email ? true : undefined
                    }
                    {...form.register("email")}
                  />
                  {form.formState.errors.email && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.email.message}
                    </p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus={!showSso}
                    aria-invalid={
                      form.formState.errors.password ? true : undefined
                    }
                    {...form.register("password")}
                  />
                  {form.formState.errors.password && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.password.message}
                    </p>
                  )}
                </div>
                {serverError && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {serverError}
                  </p>
                )}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={form.formState.isSubmitting}
                >
                  <LogIn />
                  {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
                </Button>
              </ShortcutForm>
            )}
            {!showPassword && !showSso && (
              <p className="text-sm text-muted-foreground">
                No sign-in method is configured for this server.
              </p>
            )}
            {showSso && (
              <>
                {showPassword && (
                  <div className="relative">
                    <Separator />
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs uppercase tracking-wide text-muted-foreground">
                      or
                    </span>
                  </div>
                )}
                <Button variant="outline" className="w-full" asChild>
                  <a href="/api/v1/auth/oidc/login">
                    <KeyRound />
                    Sign in with SSO
                  </a>
                </Button>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Welcome back</CardTitle>
            <CardDescription>Sign in to your apiary.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
