"use client";

/**
 * Shared bulk-select mode. Five pages used to hand-roll the same mode
 * toggle, Set-of-ids selection, and `b`/`x` shortcuts; this is the one
 * implementation.
 *
 * Semantics (matching the originals): `b` toggles bulk mode and clears the
 * selection on exit; `x` — only while in bulk mode — selects every visible
 * item, or clears the selection when everything is already selected.
 */

import * as React from "react";

import { useShortcut } from "@/components/shortcuts/provider";

export function useBulkSelect(
  visibleIds: string[],
  labels?: { mode?: string; selectAll?: string; enabled?: boolean },
) {
  const enabled = labels?.enabled ?? true;
  const [bulkMode, setBulkMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const toggleMode = React.useCallback(() => {
    setBulkMode((mode) => {
      if (mode) setSelected(new Set());
      return !mode;
    });
  }, []);

  const toggle = React.useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exit = React.useCallback(() => {
    setBulkMode(false);
    setSelected(new Set());
  }, []);

  useShortcut("b", labels?.mode ?? "Toggle bulk select", () => {
    if (enabled) toggleMode();
  });
  useShortcut("x", labels?.selectAll ?? "Select all visible", () => {
    if (!enabled || !bulkMode) return;
    setSelected(
      selected.size === visibleIds.length
        ? new Set()
        : new Set(visibleIds),
    );
  });

  return { bulkMode, selected, toggle, toggleMode, exit, setSelected };
}
