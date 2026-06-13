"use client";

import { useActionState, useRef } from "react";
import { redirect } from "next/navigation";
import { setup, isSetupComplete, type AuthFormState } from "@/actions/auth";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
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
import { useEffect, useState } from "react";

export default function SetupPage() {
  const [checking, setChecking] = useState(true);
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    setup,
    {}
  );
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(formRef, state?.values);

  useEffect(() => {
    isSetupComplete().then((complete) => {
      if (complete) {
        redirect("/login");
      } else {
        setChecking(false);
      }
    });
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to Beez Trackz</CardTitle>
          <CardDescription>
            Set up your account to get started tracking your hives.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form ref={formRef} action={formAction} className="space-y-4">
            {state.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {state.error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                name="displayName"
                type="text"
                placeholder="Your name"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                placeholder="Confirm your password"
                required
                minLength={8}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? "Setting up..." : "Complete Setup"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
