"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { useAccessProfile } from "@/features/access/api";

const passwordSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (value) =>
          value === "" ||
          (value.length >= 3 &&
            value.length <= 64 &&
            !/\s/.test(value)),
        "Username must be 3–64 characters with no spaces",
      ),
    currentPassword: z.string(),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type PasswordValues = z.infer<typeof passwordSchema>;

export function PasswordSection() {
  const profile = useAccessProfile();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const hasPassword = profile.data?.hasPassword === true;
  const email = profile.data?.email?.trim() ?? "";
  const existingUsername = profile.data?.username?.trim() ?? "";

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      username: existingUsername,
      currentPassword: "",
      password: "",
      confirmPassword: "",
    },
  });

  React.useEffect(() => {
    if (existingUsername) form.setValue("username", existingUsername);
  }, [existingUsername, form]);

  async function onSubmit(values: PasswordValues) {
    setServerError(null);
    if (!email && !values.username) {
      form.setError("username", { message: "Choose a username" });
      return;
    }
    try {
      await api.post<{ success: boolean }>("/access/me/password", {
        ...(values.username ? { username: values.username } : {}),
        ...(hasPassword ? { currentPassword: values.currentPassword } : {}),
        password: values.password,
        confirmPassword: values.confirmPassword,
      });
      toast.success(
        hasPassword
          ? "Password updated. You can still sign in with SSO."
          : "Password saved. You can sign in with email or SSO.",
      );
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["access", "me"] });
      await queryClient.invalidateQueries({ queryKey: ["auth", "status"] });
    } catch (error) {
      if (error instanceof ApiError) {
        setServerError(error.message);
      } else {
        setServerError("Could not save the password. Try again.");
      }
    }
  }

  if (profile.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading account…</p>;
  }

  const accountLabel = email || existingUsername || "this account";

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {hasPassword
          ? `Password login is on for ${accountLabel}. SSO still works.`
          : `Add a password so you can sign in without SSO. Both methods use this same account.`}
      </p>
      <ShortcutForm
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        <div className="grid gap-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            placeholder={email ? email : "e.g. justin"}
            aria-invalid={form.formState.errors.username ? true : undefined}
            {...form.register("username")}
          />
          {form.formState.errors.username && (
            <p className="text-sm text-destructive" role="alert">
              {form.formState.errors.username.message}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {email
              ? `You can also sign in with ${email}.`
              : "Required. Pick a short name you will type at the login screen."}
          </p>
        </div>
        {hasPassword ? (
          <div className="grid gap-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              aria-invalid={
                form.formState.errors.currentPassword ? true : undefined
              }
              {...form.register("currentPassword", {
                required: "Enter your current password",
              })}
            />
            {form.formState.errors.currentPassword && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.currentPassword.message}
              </p>
            )}
          </div>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor="newPassword">
            {hasPassword ? "New password" : "Password"}
          </Label>
          <Input
            id="newPassword"
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
          className="w-fit min-h-11"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting
            ? "Saving…"
            : hasPassword
              ? "Update password"
              : "Set password"}
        </Button>
      </ShortcutForm>
    </div>
  );
}
