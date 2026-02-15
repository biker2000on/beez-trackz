"use client";

/**
 * Sync indicator component
 * Shows pending sync count and active sync status
 */

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getQueueCount } from "@/lib/offline/store";
import { syncQueuedItems } from "@/lib/offline/sync";

export function SyncIndicator() {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // Update online status
  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
    };

    setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  // Poll queue count
  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateCount = async () => {
      try {
        const count = await getQueueCount();
        setPendingCount(count);
      } catch (error) {
        console.error("Failed to get queue count:", error);
      }
    };

    updateCount();
    const interval = setInterval(updateCount, 30000); // Poll every 30 seconds

    return () => clearInterval(interval);
  }, []);

  // Auto-sync when online and items pending
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = async () => {
      if (pendingCount > 0 && isOnline && !isSyncing) {
        setIsSyncing(true);
        try {
          const result = await syncQueuedItems();
          console.log(`Synced: ${result.synced}, Failed: ${result.failed}`);

          // Update count after sync
          const newCount = await getQueueCount();
          setPendingCount(newCount);
        } catch (error) {
          console.error("Sync failed:", error);
        } finally {
          setIsSyncing(false);
        }
      }
    };

    window.addEventListener("online", handleOnline);

    // Also check on mount if already online
    if (isOnline && pendingCount > 0 && !isSyncing) {
      handleOnline();
    }

    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [isOnline, pendingCount, isSyncing]);

  if (pendingCount === 0 && !isSyncing) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <RefreshCw
        className={`h-4 w-4 ${isSyncing ? "animate-spin text-blue-600" : ""}`}
      />
      {isSyncing ? (
        <span className="text-blue-600">Syncing...</span>
      ) : (
        <span>{pendingCount} item{pendingCount !== 1 ? "s" : ""} pending sync</span>
      )}
    </div>
  );
}
