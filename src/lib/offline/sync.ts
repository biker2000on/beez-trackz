"use client";

/**
 * Sync manager for offline queue
 * Handles uploading queued items to server when connection is restored
 */

import { getQueuedItems, removeFromQueue, type StoreName } from "./store";

const STORE_NAMES = ["pendingInspections", "pendingPhotos", "pendingNotes"] as const;

export interface SyncResult {
  synced: number;
  failed: number;
}

/**
 * Syncs all queued items to the server
 * Skips failed items and continues with the rest
 */
export async function syncQueuedItems(): Promise<SyncResult> {
  if (typeof window === "undefined") {
    return { synced: 0, failed: 0 };
  }

  if (!navigator.onLine) {
    console.log("Offline - skipping sync");
    return { synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const storeName of STORE_NAMES) {
    try {
      const items = await getQueuedItems(storeName as StoreName);

      for (const item of items) {
        try {
          // Determine the appropriate server action endpoint
          const endpoint = getEndpointForStore(storeName);

          // POST to server action
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: item.action,
              data: item.data,
            }),
          });

          if (response.ok) {
            // Successfully synced - remove from queue
            await removeFromQueue(storeName as StoreName, item.id);
            synced++;
          } else {
            // Server error - log and skip
            console.error(`Failed to sync item ${item.id} from ${storeName}:`, response.statusText);
            failed++;
          }
        } catch (error) {
          // Network or other error - log and continue
          console.error(`Error syncing item ${item.id} from ${storeName}:`, error);
          failed++;
        }
      }
    } catch (error) {
      console.error(`Error processing ${storeName}:`, error);
    }
  }

  return { synced, failed };
}

/**
 * Maps store name to corresponding server action endpoint
 */
function getEndpointForStore(storeName: string): string {
  const endpointMap: Record<string, string> = {
    pendingInspections: "/api/sync/inspections",
    pendingPhotos: "/api/sync/photos",
    pendingNotes: "/api/sync/notes",
  };

  return endpointMap[storeName] || "/api/sync/generic";
}

/**
 * Sets up automatic sync when connection is restored
 * Should be called once on app initialization
 */
export function setupAutoSync(): void {
  if (typeof window === "undefined") return;

  // Sync when connection is restored
  window.addEventListener("online", async () => {
    console.log("Connection restored - syncing queued items");
    try {
      const result = await syncQueuedItems();
      console.log(`Sync complete: ${result.synced} synced, ${result.failed} failed`);
    } catch (error) {
      console.error("Auto-sync failed:", error);
    }
  });

  // Optional: sync on page load if online
  if (navigator.onLine) {
    setTimeout(async () => {
      try {
        const result = await syncQueuedItems();
        if (result.synced > 0 || result.failed > 0) {
          console.log(`Initial sync: ${result.synced} synced, ${result.failed} failed`);
        }
      } catch (error) {
        console.error("Initial sync failed:", error);
      }
    }, 1000); // Small delay to avoid blocking initial render
  }
}
