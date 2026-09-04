"use client";

import { CheckCircle2, Download, Share } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useBrand } from "@/components/brand-provider";
import {
  clearInstallPromptSnooze,
  useInstallPrompt,
} from "@/components/install-prompt";

export function InstallSection() {
  const { available, installed, ios, snoozed, standalone, promptInstall } =
    useInstallPrompt();
  const brand = useBrand();

  async function handleInstall() {
    const outcome = await promptInstall();
    if (outcome === "accepted") toast.success(`Installing ${brand.displayName}…`);
  }

  if (installed || standalone) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-success" />
        {brand.displayName} is installed on this device.
      </p>
    );
  }

  if (available) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Install {brand.displayName} for a full-screen app with its own icon.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" onClick={() => void handleInstall()}>
            <Download />
            Install app
          </Button>
          {snoozed ? (
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={() => {
                clearInstallPromptSnooze();
                toast.success("Install reminders turned back on");
              }}
            >
              Re-enable install reminders
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (ios) {
    return (
      <div className="grid gap-2 text-sm text-muted-foreground">
        <p>To install on iPhone or iPad:</p>
        <ol className="grid list-decimal gap-1 pl-5">
          <li className="[&>svg]:inline">
            Tap the <Share className="mx-0.5 inline size-4 align-text-bottom" />
            <span className="font-medium text-foreground"> Share</span> button
            in Safari.
          </li>
          <li>
            Choose{" "}
            <span className="font-medium text-foreground">
              Add to Home Screen
            </span>
            .
          </li>
          <li>
            Tap <span className="font-medium text-foreground">Add</span>.
          </li>
        </ol>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Your browser hasn&apos;t offered an install prompt yet. Look for
      &quot;Install app&quot; in the browser menu, or revisit after browsing
      for a bit.
    </p>
  );
}
