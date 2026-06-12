"use client";

import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

/**
 * Floating action bar shown while a bulk selection is active. Sits above
 * the mobile bottom nav; actions are provided by the caller.
 */
export function BulkActionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-16 md:bottom-4 z-40 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-lg">
        <span className="text-sm font-medium tabular-nums px-1">
          {count} selected
        </span>
        {children}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
