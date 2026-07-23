/**
 * Transcription feature API layer.
 *
 * The shared `api` client is JSON-oriented, so the audio upload uses a small
 * multipart helper here (raw fetch, same-origin cookies, same error shape).
 */

import { api, ApiError } from "@/lib/api";

export type TranscriptionMode = "single" | "batch";

export type TranscriptionStatus =
  | "pending"
  | "processing"
  | "complete"
  | "failed";

/** Matches backend ai.Pest / ai.Treatment jsonb shapes. */
export interface Pest {
  type: string;
  count?: string | null;
}

export interface Treatment {
  product: string;
  method?: string | null;
}

/** One parsed inspection, annotated with a fuzzy hive match in batch mode. */
export interface ParsedInspection {
  hiveReference?: string | null;
  queenSeen?: boolean | null;
  queenHealth?: string | null;
  broodPattern?: string | null;
  storesHoney?: number | null;
  storesPollen?: number | null;
  temperament?: number | null;
  pests?: Pest[] | null;
  treatments?: Treatment[] | null;
  notes?: string | null;
  matchedHiveId?: string | null;
}

/** Server-side parse result (parsed once with the status — no client re-parse). */
export interface ParsedResult {
  rawText: string;
  inspections: ParsedInspection[];
}

/** GET /transcriptions/{id} response. */
export interface Transcription {
  id: string;
  status: TranscriptionStatus;
  transcriptionText: string | null;
  error: string | null;
  ownerType: "hive" | "apiary";
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** Present when status is complete and the parse succeeded. */
  parsed?: ParsedResult;
  /** Present when status is complete but the AI parse failed. */
  parseError?: string;
}

/** One confirmed inspection sent to POST /transcriptions/{id}/confirm. */
export interface ConfirmInspection extends ParsedInspection {
  hiveId?: string | null;
}

export interface ConfirmResult {
  success: boolean;
  inspectionIds: string[];
}

/** Subset of the hive list/detail response used by this feature. */
export interface HiveSummary {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  status: string;
  isArchived: boolean;
}

/** Subset of the apiary list response used by this feature. */
export interface ApiarySummary {
  id: string;
  name: string;
  hiveCount: number;
}

export interface UploadTranscriptionInput {
  audio: Blob;
  ownerType: "hive" | "apiary";
  ownerId: string;
  mode: TranscriptionMode;
}

/** Maps a recording mime type to a sensible upload filename. */
function audioFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

/**
 * POST /transcriptions — multipart upload. Raw fetch because the shared api
 * client always JSON-encodes bodies.
 */
export async function uploadTranscription({
  audio,
  ownerType,
  ownerId,
  mode,
}: UploadTranscriptionInput): Promise<{ mediaFileId: string }> {
  const form = new FormData();
  form.append("audio", audio, audioFileName(audio.type));
  form.append("ownerType", ownerType);
  form.append("ownerId", ownerId);
  form.append("mode", mode);

  const res = await fetch("/api/v1/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
    body: form,
  });

  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ??
      `Upload failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as { mediaFileId: string };
}

/** GET /transcriptions/{id}?mode= — status plus parsed data when complete. */
export function getTranscription(
  id: string,
  mode: TranscriptionMode,
): Promise<Transcription> {
  return api.get<Transcription>(`/transcriptions/${id}`, {
    params: { mode },
  });
}

/** POST /transcriptions/{id}/parse — "Re-parse with AI". */
export function parseTranscription(
  id: string,
  mode: TranscriptionMode,
): Promise<ParsedResult> {
  return api.post<ParsedResult>(`/transcriptions/${id}/parse`, { mode });
}

/** POST /transcriptions/{id}/confirm — create inspections from reviewed data. */
export function confirmTranscription(
  id: string,
  mode: TranscriptionMode,
  inspections: ConfirmInspection[],
): Promise<ConfirmResult> {
  return api.post<ConfirmResult>(`/transcriptions/${id}/confirm`, {
    mode,
    inspections,
  });
}

export function listHives(): Promise<HiveSummary[]> {
  return api.get<HiveSummary[]>("/hives");
}

export function getHive(id: string): Promise<HiveSummary> {
  return api.get<HiveSummary>(`/hives/${id}`);
}

export function listApiaries(): Promise<ApiarySummary[]> {
  return api.get<ApiarySummary[]>("/apiaries");
}
