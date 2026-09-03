"use client";

import * as React from "react";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

/**
 * Whether the browser believes it has a connection.
 *
 * This answers "may an online_only command be pressed right now?", which is a
 * different question from "is this data stale?" — a live connection can still
 * be serving a cached body, and a cached body can be perfectly current. The
 * two are rendered as two separate markers for that reason.
 */
export function useOnline(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true, // assume online during SSR
  );
}
