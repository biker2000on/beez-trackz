"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Check, Share, Plus } from "lucide-react";
import { usePwaInstall } from "./pwa-install-provider";

/**
 * Settings entry to install the app on demand — works even after the
 * install toast has been dismissed.
 */
export function InstallAppSetting() {
  const { canInstall, isInstalled, isIos, promptInstall } = usePwaInstall();
  const [busy, setBusy] = useState(false);

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center gap-3 pb-2">
        <Download className="h-5 w-5 text-muted-foreground" />
        <CardTitle className="text-base">Install App</CardTitle>
      </CardHeader>
      <CardContent>
        {isInstalled ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check className="h-4 w-4 text-green-600" />
            Installed — you&apos;re running the app.
          </p>
        ) : isIos ? (
          <p className="text-sm text-muted-foreground">
            Tap the Share button{" "}
            <Share className="inline h-4 w-4 -mt-0.5" aria-label="Share" /> then{" "}
            <span className="whitespace-nowrap font-medium text-foreground">
              Add to Home Screen{" "}
              <Plus className="inline h-3.5 w-3.5 -mt-0.5" aria-hidden />
            </span>
            .
          </p>
        ) : canInstall ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add Beez Trackz to your device for quick, offline access.
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await promptInstall();
                setBusy(false);
              }}
            >
              <Download className="h-4 w-4 mr-2" />
              {busy ? "Installing…" : "Install app"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Open this site in Chrome or Edge to install, or it may already be
            installed on this device.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
