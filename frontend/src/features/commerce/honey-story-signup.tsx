"use client";

import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShortcutForm } from "@/components/ui/shortcut-form";

export function HoneyStorySignup({ slug }: { slug: string }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [subscribed, setSubscribed] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const response = await fetch(`/api/v1/public/honey-stories/${slug}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name || undefined }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to save your email");
      }

      setSubscribed(true);
      toast.success("You’ll hear when this apiary has more honey.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to subscribe");
    } finally {
      setSubmitting(false);
    }
  }

  if (subscribed) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center text-amber-950">
        <Mail className="mx-auto mb-3 h-7 w-7" />
        <p className="font-semibold">You’re on the list.</p>
        <p className="mt-1 text-sm text-amber-800">
          We’ll let you know when honey from this apiary is available again.
        </p>
      </div>
    );
  }

  return (
    <ShortcutForm className="space-y-3" onSubmit={submit}>
      <Input
        aria-label="Your name"
        autoComplete="name"
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name (optional)"
        value={name}
      />
      <Input
        aria-label="Email address"
        autoComplete="email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={email}
      />
      <Button className="w-full bg-amber-600 text-white hover:bg-amber-700" disabled={submitting} type="submit">
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Let me know about the next harvest
      </Button>
    </ShortcutForm>
  );
}
