"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export function ComplianceSection() {
  const [busy, setBusy] = React.useState(false);

  async function download() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/ops/compliance-packet", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Download failed (${response.status})`);
      }
      const blob = await response.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `beez-trackz-compliance-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Compliance packet downloaded");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not download packet",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        One authenticated export for the inspector or market manager: hive
        list, treatments, lots, sales, and withdrawal windows. Not public.
      </p>
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={busy}
        onClick={() => void download()}
      >
        <Download />
        Download compliance packet
      </Button>
    </div>
  );
}
