import type {
  ConfirmInspection,
  ConfirmResult,
  TranscriptionMode,
} from "./api";
import type { EditableInspection } from "./inspection-fields";

export interface ReviewDraft {
  itemKey: string;
  scope: "apiary" | "hive";
  hiveId: string;
  fields: ConfirmInspection;
  editable?: EditableInspection;
  mutationId?: string;
  pending?: ConfirmInspection;
  receipt?: ConfirmResult;
  queued?: boolean;
}

/** A device journal, partitioned by account. Never an inventory authority. */
export interface LocalCapture {
  captureId: string;
  userId: string;
  ownerType: "apiary" | "hive";
  ownerId: string;
  mode: TranscriptionMode;
  observedAt: string;
  timeZone: string;
  audio?: Blob;
  audioFileName?: string;
  mediaFileId?: string;
  uploadAttempted?: boolean;
  replacesMediaFileId?: string;
  drafts?: ReviewDraft[];
  versionId?: string;
  state: "recording" | "captured" | "uploaded" | "review" | "saved";
  manual?: boolean;
  manualEntry?: boolean;
  updatedAt: string;
}

const DATABASE = "atlas-voice-captures";
const STORE = "captures";

function openJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "This browser cannot keep recordings safely on this device. Try another browser or use manual entry.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, {
        keyPath: ["userId", "captureId"],
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open recording storage."));
    request.onblocked = () =>
      reject(new Error("Close other Atlas tabs and retry recording storage."));
  });
}

export async function saveCapture(capture: LocalCapture): Promise<void> {
  const db = await openJournal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(capture);
      // Request success is not durability: wait until the transaction commits.
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          tx.error ??
            new Error(
              "Recording could not be saved on this device. Check available storage.",
            ),
        );
      tx.onabort = () =>
        reject(
          tx.error ??
            new Error(
              "Recording storage was interrupted. Keep this page open and retry.",
            ),
        );
    });
  } finally {
    db.close();
  }
}

export async function readCapture(
  userId: string,
  captureId: string,
): Promise<LocalCapture | undefined> {
  const db = await openJournal();
  try {
    return await new Promise<LocalCapture | undefined>((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get([userId, captureId]);
      request.onsuccess = () =>
        resolve(request.result as LocalCapture | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function listCaptures(userId: string): Promise<LocalCapture[]> {
  const db = await openJournal();
  try {
    return await new Promise<LocalCapture[]>((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as LocalCapture[])
            .filter((record) => record.userId === userId)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteCapture(
  userId: string,
  captureId: string,
): Promise<void> {
  const db = await openJournal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete([userId, captureId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
