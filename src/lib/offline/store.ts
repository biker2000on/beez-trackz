"use client";

/**
 * Offline data store using IndexedDB
 * Manages queued items for sync when connection is restored
 */

const DB_NAME = "beez-trackz-offline";
const DB_VERSION = 1;
const STORE_NAMES = ["pendingInspections", "pendingPhotos", "pendingNotes"] as const;

export type StoreName = typeof STORE_NAMES[number];

export type QueuedAction = "create" | "update" | "delete";

export interface QueuedItem {
  id: number;
  action: QueuedAction;
  data: unknown;
  timestamp: number;
  synced: number; // 0 = not synced, 1 = synced (boolean not valid as IndexedDB key)
}

/**
 * Opens the offline IndexedDB database
 * Creates object stores if they don't exist
 */
export function openOfflineDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB is only available in browser"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error("Failed to open IndexedDB"));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create object stores if they don't exist
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          const objectStore = db.createObjectStore(storeName, {
            keyPath: "id",
            autoIncrement: true,
          });
          objectStore.createIndex("timestamp", "timestamp", { unique: false });
          objectStore.createIndex("synced", "synced", { unique: false });
        }
      }
    };
  });
}

/**
 * Adds an item to the sync queue
 * @returns The ID of the queued item
 */
export async function addToQueue(
  storeName: StoreName,
  action: QueuedAction,
  data: unknown
): Promise<number> {
  const db = await openOfflineDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    const item: Omit<QueuedItem, "id"> = {
      action,
      data,
      timestamp: Date.now(),
      synced: 0,
    };

    const request = store.add(item);

    request.onsuccess = () => {
      resolve(request.result as number);
    };

    request.onerror = () => {
      reject(new Error(`Failed to add item to ${storeName}`));
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Gets all queued items from a specific store
 */
export async function getQueuedItems(storeName: StoreName): Promise<QueuedItem[]> {
  const db = await openOfflineDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const index = store.index("synced");
    const request = index.getAll(IDBKeyRange.only(0));

    request.onsuccess = () => {
      resolve(request.result as QueuedItem[]);
    };

    request.onerror = () => {
      reject(new Error(`Failed to get items from ${storeName}`));
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Removes an item from the sync queue
 */
export async function removeFromQueue(
  storeName: StoreName,
  id: number
): Promise<void> {
  const db = await openOfflineDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error(`Failed to remove item ${id} from ${storeName}`));
    };

    transaction.oncomplete = () => {
      db.close();
    };
  });
}

/**
 * Gets total count of pending items across all stores
 */
export async function getQueueCount(): Promise<number> {
  const db = await openOfflineDB();

  return new Promise((resolve, reject) => {
    let totalCount = 0;
    let completedStores = 0;

    for (const storeName of STORE_NAMES) {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const index = store.index("synced");
      const request = index.count(IDBKeyRange.only(0));

      request.onsuccess = () => {
        totalCount += request.result;
        completedStores++;

        if (completedStores === STORE_NAMES.length) {
          db.close();
          resolve(totalCount);
        }
      };

      request.onerror = () => {
        db.close();
        reject(new Error(`Failed to count items in ${storeName}`));
      };
    }
  });
}
