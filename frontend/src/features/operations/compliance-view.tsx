"use client";

import * as React from "react";
import { Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { AdminReportGate } from "./reports-nav";

/**
 * `/insights/compliance` — the authenticated compliance packet (design
 * 2026-09-03 §6.3, S5). It is a generated report over hives, treatments,
 * lots, sales and withdrawal windows; nothing about it is configuration, so
 * it left Settings with the split.
 */
export function ComplianceView() {
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
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Compliance packet</h1>
        <p className="text-sm text-muted-foreground">
          One export for the inspector or market manager.
        </p>
      </div>
      <AdminReportGate>
        <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        One authenticated export for the inspector or market manager: hive
        list, treatments, lots, sales, and withdrawal windows. Not public.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void download()}
        >
          <Download />
          Download JSON
        </Button>
        <Button asChild variant="outline">
          <a
            href="/api/v1/ops/compliance-packet/print"
            target="_blank"
            rel="noreferrer"
          >
            <Printer />
            Print / save PDF
          </a>
        </Button>
      </div>
        </div>
      </AdminReportGate>
    </div>
  );
}
