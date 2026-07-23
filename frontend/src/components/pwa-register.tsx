"use client";

import * as React from "react";

/**
 * Register the production service worker. The app remains online-first: API
 * writes are never queued or cached, while the installable shell and static
 * assets remain available when a beekeeper loses signal in the yard.
 */
export function PwaRegister() {
  React.useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    const register = () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
