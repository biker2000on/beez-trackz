"use client";

import { X, Share, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "./pwa-install-provider";

export function InstallPrompt() {
  const { canInstall, isInstalled, isIos, dismissed, promptInstall, dismiss } =
    usePwaInstall();

  // Show once, until the user makes any choice. Dismissal is persisted, so it
  // never comes back on its own — re-install from Settings → Install app.
  const show = !dismissed && !isInstalled && (canInstall || isIos);
  if (!show) return null;

  const handleInstall = async () => {
    await promptInstall();
    dismiss(); // either it installed, or they declined — don't nag again
  };

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

          {isIos ? (
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
            {!isIos && (
              <Button size="sm" onClick={handleInstall}>
                Install
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={dismiss}>
              {isIos ? "Got it" : "Not now"}
            </Button>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
