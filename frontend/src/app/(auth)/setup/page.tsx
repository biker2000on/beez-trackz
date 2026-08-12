"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Sparkles } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";
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

const setupSchema = z
  .object({
    displayName: z.string().trim().min(1, "Enter a display name"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SetupValues = z.infer<typeof setupSchema>;

export default function SetupPage() {
  const router = useRouter();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<SetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { displayName: "", password: "", confirmPassword: "" },
  });

  async function onSubmit(values: SetupValues) {
    setServerError(null);
    try {
      await api.post<{ success: boolean }>("/auth/setup", {
        displayName: values.displayName,
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      toast.success("All set! Sign in with your new password.");
      router.replace("/login");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409) {
          // Setup already done — just go sign in.
          router.replace("/login");
          return;
        }
        setServerError(error.message);
      } else {
        setServerError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Sparkles className="size-5 text-primary" />
          Welcome to Beez Trackz
        </CardTitle>
        <CardDescription>
          Set up your beekeeper account to get started.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ShortcutForm
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid gap-4"
          noValidate
        >
          <div className="grid gap-2">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              autoComplete="name"
              autoFocus
              placeholder="e.g. Maya the Beekeeper"
              aria-invalid={form.formState.errors.displayName ? true : undefined}
              {...form.register("displayName")}
            />
            {form.formState.errors.displayName && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.displayName.message}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={form.formState.errors.password ? true : undefined}
              {...form.register("password")}
            />
            {form.formState.errors.password && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.password.message}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              aria-invalid={
                form.formState.errors.confirmPassword ? true : undefined
              }
              {...form.register("confirmPassword")}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.confirmPassword.message}
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
            {form.formState.isSubmitting ? "Setting up…" : "Create account"}
          </Button>
        </ShortcutForm>
      </CardContent>
    </Card>
  );
}
