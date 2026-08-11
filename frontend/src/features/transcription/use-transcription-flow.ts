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

export interface TranscriptionFlow {
  /** Media file id once the upload succeeded. */
  mediaFileId: string | null;
  /** True while the audio blob is being uploaded. */
  uploading: boolean;
  /** Upload failure message, when the POST itself failed. */
  uploadError: string | null;
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
 * is pending/processing. Retry re-uploads the same blob as a new job.
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
    // Keep polling while the job is queued or running; stop on a final state.
    // Undefined data (the first status fetch failed on a flaky field link)
    // must keep polling too — returning false there stopped polling forever
    // and left the spinner up after a successful upload.
    refetchInterval: (query) => {
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
    if (!blob || !ownerId) return;
    setMediaFileId(null);
    uploadMutation.mutate({ audio: blob, ownerType, ownerId, mode });
  }, [blob, mode, ownerId, ownerType, uploadMutation]);

  const reset = React.useCallback(() => {
    setBlob(null);
    setMediaFileId(null);
    uploadMutation.reset();
  }, [uploadMutation]);

  const transcription = statusQuery.data;
  const processing =
    mediaFileId !== null &&
    (transcription === undefined ||
      transcription.status === "pending" ||
      transcription.status === "processing");

  return {
    mediaFileId,
    uploading: uploadMutation.isPending,
    uploadError: uploadMutation.isError
      ? uploadMutation.error.message
      : null,
    transcription,
    processing,
    upload,
    retry,
    canRetry: blob !== null,
    reset,
  };
}
