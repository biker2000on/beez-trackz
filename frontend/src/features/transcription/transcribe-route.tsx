"use client";

import { VisitWorkspace } from "./visit-workspace";

/**
 * One voice surface for the Yard (design 2026-09-03 S10).
 *
 * `?hive={id}` records a single inspection; anything else (including
 * `?apiary={id}`) is the apiary walkthrough. The two used to be separate
 * routes over the same `features/transcription` code.
 */
export function TranscribeRouteView() {
  return <VisitWorkspace />;
}
