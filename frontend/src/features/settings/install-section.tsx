"use client";

import * as React from "react";
import { CheckCircle2, Download, Share } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Chromium-only event fired when the PWA is installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports as Mac but has touch points.
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function InstallSection() {
  const [installEvent, setInstallEvent] =
    React.useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = React.useState(false);
  // Lazy init: this component only ever renders client-side (the app layout
  // gates on the auth query), so the checks are safe here.
  const [env] = React.useState<{ ios: boolean; standalone: boolean }>(() => ({
    ios: isIOS(),
    standalone: isStandalone(),
  }));

  React.useEffect(() => {
    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      setInstalled(true);
      setInstallEvent(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") {
      toast.success("Installing Beez Trackz…");
      setInstallEvent(null);
    }
  }

  if (installed || env.standalone) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-success" />
        Beez Trackz is installed on this device.
      </p>
    );
  }

  if (installEvent) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Install Beez Trackz for a full-screen app with its own icon.
        </p>
        <div>
          <Button onClick={handleInstall}>
            <Download />
            Install app
          </Button>
        </div>
      </div>
    );
  }

  if (env.ios) {
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
