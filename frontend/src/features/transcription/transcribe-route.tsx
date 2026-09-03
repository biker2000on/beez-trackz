"use client";

import { useSearchParams } from "next/navigation";

import { BatchTranscribePage } from "./batch-transcribe-page";
import { HiveTranscribePage } from "./hive-transcribe-page";

/**
 * One voice surface for the Yard (design 2026-09-03 S10).
 *
 * `?hive={id}` records a single inspection; anything else (including
 * `?apiary={id}`) is the apiary walkthrough. The two used to be separate
 * routes over the same `features/transcription` code.
 */
export function TranscribeRouteView() {
  const hiveId = useSearchParams().get("hive");
  return hiveId ? (
    <HiveTranscribePage hiveId={hiveId} />
  ) : (
    <BatchTranscribePage />
  );
}
