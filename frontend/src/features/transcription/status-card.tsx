"use client";

import { AlertCircle, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import type { TranscriptionFlow } from "./use-transcription-flow";

/**
 * Job status card shown between upload and review: Queued… / Transcribing…
 * spinner, or a failed state with the error text and a Retry (re-upload the
 * same recording) button.
 */
export function TranscriptionStatusCard({ flow }: { flow: TranscriptionFlow }) {
  const failed =
    flow.uploadError !== null || flow.transcription?.status === "failed";

  if (failed) {
    const message =
      flow.uploadError ??
      flow.transcription?.error ??
      "Transcription failed for an unknown reason.";
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <AlertCircle className="size-8 text-destructive" />
          <div>
            <p className="font-medium">Transcription failed</p>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          </div>
          {flow.canRetry && (
            <Button type="button" variant="outline" onClick={flow.retry}>
              <RotateCcw />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const label = flow.uploading
    ? "Uploading recording…"
    : flow.transcription?.status === "processing"
      ? "Transcribing…"
      : "Queued…";
  const detail = flow.uploading
    ? "Sending your audio to the server."
    : flow.transcription?.status === "processing"
      ? "The AI is transcribing your recording. This can take a minute."
      : "Waiting for a worker to pick up the job.";

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <div>
          <p className="font-medium">{label}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}
