"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

export function OfflineBanner() {
  const offline = React.useSyncExternalStore(
    subscribe,
    () => !navigator.onLine,
    () => false, // assume online during SSR
  );

  if (!offline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-warning px-4 py-1.5 text-xs font-medium text-black/80"
    >
      <WifiOff className="size-3.5" />
      You are offline — cached field data is available and supported changes
      will sync after reconnecting.
    </div>
  );
}
