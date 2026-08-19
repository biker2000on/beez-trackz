"use client";

/**
 * Shared bulk-select mode. Five pages used to hand-roll the same mode
 * toggle, Set-of-ids selection, and `b`/`x` shortcuts; this is the one
 * implementation.
 *
 * Semantics: `b` toggles bulk mode; `x` — only while in bulk mode — selects
 * every visible item, or clears the selection when everything is already
 * selected. Leaving bulk mode keeps the selection so "archive the deadouts,
 * but let me double-check that one" does not mean redoing the whole
 * selection; only "Clear all" (or a completed bulk action, via `finish`)
 * empties it.
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
    setBulkMode((mode) => !mode);
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
  }, []);

  /** Leave bulk mode after the selected items have been acted on. */
  const finish = React.useCallback(() => {
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

  return { bulkMode, selected, toggle, toggleMode, exit, finish, setSelected };
}
