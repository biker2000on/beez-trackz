"use client";

import { useEffect } from "react";
import { setupAutoSync } from "@/lib/offline/sync";

export function AutoSyncInit() {
  useEffect(() => {
    setupAutoSync();
  }, []);

  return null;
}
