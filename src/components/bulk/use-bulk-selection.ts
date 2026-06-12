"use client";

import { useCallback, useState } from "react";

/** Selection state for bulk operations over a list of ids. */
export function useBulkSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
  }, []);

  const toggleSelecting = useCallback(() => {
    setSelecting((prev) => {
      if (prev) setSelected(new Set());
      return !prev;
    });
  }, []);

  return { selecting, selected, toggle, selectAll, clear, toggleSelecting };
}
