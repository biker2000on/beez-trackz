"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  getTranscription,
  uploadTranscription,
  type Transcription,
  type TranscriptionMode,
} from "./api";

const POLL_INTERVAL_MS = 3000;
/** First-fetch (data still undefined) polls before we give up and surface an error. */
const MAX_EMPTY_POLLS = 20;

export interface TranscriptionFlow {
  /** Media file id once the upload succeeded. */
  mediaFileId: string | null;
  /** True while the audio blob is being uploaded. */
  uploading: boolean;
  /** Upload failure message, when the POST itself failed. */
  uploadError: string | null;
  /** Status-poll failure (isError / exhausted empty polls). */
  pollError: string | null;
  /** Latest polled transcription record. */
  transcription: Transcription | undefined;
  /** True from upload success until the job leaves pending/processing. */
  processing: boolean;
  /** Kick off an upload of a fresh recording. */
  upload: (blob: Blob) => void;
  /** Re-upload the same blob after a failure. */
  retry: () => void;
  /** Whether a retry is possible (a blob is held). */
  canRetry: boolean;
  /** Forget the current job and start over. */
  reset: () => void;
}

/**
 * Upload → poll state machine shared by the single and batch pages: POST the
 * multipart audio, then poll GET /transcriptions/{id} every 3s while the job
 * is pending/processing. Retry refetches a failed poll, or re-uploads the
 * same blob as a new job when the POST itself failed.
 */
export function useTranscriptionFlow(options: {
  mode: TranscriptionMode;
  ownerType: "hive" | "apiary";
  ownerId: string | null;
}): TranscriptionFlow {
  const { mode, ownerType, ownerId } = options;
  const [blob, setBlob] = React.useState<Blob | null>(null);
  const [mediaFileId, setMediaFileId] = React.useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: uploadTranscription,
    onSuccess: (data) => setMediaFileId(data.mediaFileId),
  });

  const statusQuery = useQuery({
    queryKey: ["transcription", mediaFileId, mode],
    queryFn: () => getTranscription(mediaFileId!, mode),
    enabled: mediaFileId !== null,
    // Count each interval as one attempt so a flaky first fetch can recover
    // without the default 3-retry burst inflating the cap.
    retry: false,
    // Keep polling while the job is queued or running; stop on a final state.
    // Undefined data (the first status fetch failed on a flaky field link)
    // keeps polling, but only up to MAX_EMPTY_POLLS — otherwise the spinner
    // never stops.
    refetchInterval: (query) => {
      if (query.state.fetchFailureCount >= MAX_EMPTY_POLLS) return false;
      if (query.state.data === undefined) return POLL_INTERVAL_MS;
      const status = query.state.data.status;
      return status === "pending" || status === "processing"
        ? POLL_INTERVAL_MS
        : false;
    },
  });

  const upload = React.useCallback(
    (audio: Blob) => {
      if (!ownerId) return;
      setBlob(audio);
      setMediaFileId(null);
      uploadMutation.mutate({ audio, ownerType, ownerId, mode });
    },
    [mode, ownerId, ownerType, uploadMutation],
  );

  const retry = React.useCallback(() => {
    if (mediaFileId && (statusQuery.isError || statusQuery.failureCount >= MAX_EMPTY_POLLS)) {
      void statusQuery.refetch();
      return;
    }
    if (!blob || !ownerId) return;
    setMediaFileId(null);
    uploadMutation.mutate({ audio: blob, ownerType, ownerId, mode });
  }, [
    blob,
    mediaFileId,
    mode,
    ownerId,
    ownerType,
    statusQuery,
    uploadMutation,
  ]);

  const reset = React.useCallback(() => {
    setBlob(null);
    setMediaFileId(null);
    uploadMutation.reset();
  }, [uploadMutation]);

  const transcription = statusQuery.data;
  const pollsExhausted = statusQuery.failureCount >= MAX_EMPTY_POLLS;
  // First-fetch misses keep spinning (and polling) until the cap; a
  // last-known pending status is not a poll error unless we then fail
  // MAX_EMPTY_POLLS times in a row.
  const waitingOnFirstStatus =
    transcription === undefined && statusQuery.failureCount < MAX_EMPTY_POLLS;
  const pollError =
    mediaFileId !== null &&
    (statusQuery.isError || pollsExhausted) &&
    !waitingOnFirstStatus &&
    (transcription === undefined || pollsExhausted)
      ? statusQuery.error instanceof Error
        ? statusQuery.error.message
        : "Lost contact with the transcription job."
      : null;
  const processing =
    mediaFileId !== null &&
    pollError === null &&
    (transcription === undefined ||
      transcription.status === "pending" ||
      transcription.status === "processing");

  return {
    mediaFileId,
    uploading: uploadMutation.isPending,
    uploadError: uploadMutation.isError
      ? uploadMutation.error.message
      : null,
    pollError,
    transcription,
    processing,
    upload,
    retry,
    canRetry:
      blob !== null ||
      (mediaFileId !== null && pollError !== null),
    reset,
  };
}
