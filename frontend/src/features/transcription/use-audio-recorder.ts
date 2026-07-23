"use client";

import * as React from "react";

/** Preference order for MediaRecorder container/codec. */
const MIME_PREFERENCES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

/** Auto-stop long recordings at 30 minutes. */
export const MAX_RECORDING_SECONDS = 30 * 60;

export type RecorderStatus = "idle" | "recording" | "recorded";

export interface AudioRecorderState {
  status: RecorderStatus;
  /** Friendly error message (permission denied, no mic, unsupported). */
  error: string | null;
  /** Elapsed recording time in whole seconds. */
  elapsed: number;
  /** The finished recording, ready for playback/upload. */
  blob: Blob | null;
  /** Object URL for the finished recording (for <audio controls>). */
  blobUrl: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** Discard the current recording and return to idle. */
  reset: () => void;
}

function pickMimeType(): string {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }
  return MIME_PREFERENCES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

function friendlyMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone access was denied. Allow microphone access in your browser settings and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect a microphone and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is in use by another application. Close it and try again.";
    default:
      return "Could not start recording. Check your microphone and try again.";
  }
}

/**
 * MediaRecorder hook: mic permission handling, live elapsed timer, 30-minute
 * auto-stop, and a playback-ready blob when the recording finishes.
 */
export function useAudioRecorder(): AudioRecorderState {
  const [status, setStatus] = React.useState<RecorderStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [blob, setBlob] = React.useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const blobUrlRef = React.useRef<string | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const revokeUrl = React.useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    clearTimer();
  }, [clearTimer]);

  const start = React.useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        "Audio recording is not supported in this browser. Note that recording requires a secure (HTTPS) connection.",
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(friendlyMicError(err));
      return;
    }

    revokeUrl();
    setBlob(null);
    setBlobUrl(null);
    chunksRef.current = [];
    streamRef.current = stream;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
    } catch {
      releaseStream();
      setError("Could not start recording with this browser's audio support.");
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      const recorded = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      releaseStream();
      const url = URL.createObjectURL(recorded);
      blobUrlRef.current = url;
      setBlob(recorded);
      setBlobUrl(url);
      setStatus("recorded");
    };

    recorderRef.current = recorder;
    recorder.start(1000);
    setElapsed(0);
    setStatus("recording");

    const startedAt = Date.now();
    clearTimer();
    timerRef.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) stop();
    }, 500);
  }, [clearTimer, releaseStream, revokeUrl, stop]);

  const reset = React.useCallback(() => {
    stop();
    revokeUrl();
    setBlob(null);
    setBlobUrl(null);
    setElapsed(0);
    setError(null);
    setStatus("idle");
  }, [revokeUrl, stop]);

  // Tear down the recorder, stream, timer, and object URL on unmount.
  React.useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  return { status, error, elapsed, blob, blobUrl, start, stop, reset };
}

/** Formats whole seconds as m:ss (or h:mm:ss past an hour). */
export function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : mmss;
}
