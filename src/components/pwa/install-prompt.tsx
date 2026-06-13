"use client";

import { useEffect, useState } from "react";
import { X, Share, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa-install-dismissed";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof window === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    // iPadOS reports as Mac with a touch screen
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1)
  );
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return;
    if (isStandalone()) return; // already installed

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };
    window.addEventListener("beforeinstallprompt", handler);

    // iOS Safari never fires beforeinstallprompt — show manual instructions.
    if (isIos()) {
      setIosHint(true);
      setShowPrompt(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setShowPrompt(false);
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    setShowPrompt(false);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] left-4 right-4 md:bottom-4 md:left-auto md:right-4 md:w-96 z-50 rounded-lg border bg-card p-4 shadow-lg animate-in slide-in-from-bottom-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-2xl" aria-hidden>
              🐝
            </span>
            <h3 className="font-semibold">Install Beez Trackz</h3>
          </div>

          {iosHint ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Tap the Share button{" "}
              <Share className="inline h-4 w-4 -mt-0.5" aria-label="Share" /> then{" "}
              <span className="whitespace-nowrap font-medium text-foreground">
                Add to Home Screen{" "}
                <Plus className="inline h-3.5 w-3.5 -mt-0.5" aria-hidden />
              </span>{" "}
              to install the app.
            </p>
          ) : (
            <p className="mb-3 text-sm text-muted-foreground">
              Install for quick access to your hives — works offline, too.
            </p>
          )}

          <div className="flex gap-2">
            {!iosHint && (
              <Button size="sm" onClick={handleInstallClick}>
                Install
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleDismiss}>
              {iosHint ? "Got it" : "Not now"}
            </Button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
