"use client";

import * as React from "react";

/**
 * One boolean in localStorage, read through useSyncExternalStore so the
 * server render and hydration use `initial` and the stored choice applies
 * straight after. Storage can throw (private windows, blocked site data);
 * then the flag lives in memory for this visit.
 */
const EVENT = "atlas:stored-flag";
const memory = new Map<string, boolean>();

function read(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useStoredFlag(key: string, initial: boolean) {
  const value = React.useSyncExternalStore(
    subscribe,
    () => read(key) ?? initial,
    () => initial,
  );
  const set = React.useCallback(
    (next: boolean) => {
      memory.set(key, next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // kept in memory for this visit
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set] as const;
}
