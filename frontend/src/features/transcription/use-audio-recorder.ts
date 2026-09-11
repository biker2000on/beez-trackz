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

export interface AudioRecorderOptions {
  /** Receives a complete cumulative audio snapshot, roughly every five seconds.
   * Resolve only once the blob is durable. A rejected write stops the recording
   * while retaining its finished blob so the user can retry or download it. */
  onCheckpoint?: (blob: Blob) => void | Promise<void>;
}

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
export function useAudioRecorder(options: AudioRecorderOptions = {}): AudioRecorderState {
  const [status, setStatus] = React.useState<RecorderStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [blob, setBlob] = React.useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);

  const checkpointRef = React.useRef(options.onCheckpoint);
  React.useEffect(() => { checkpointRef.current = options.onCheckpoint; }, [options.onCheckpoint]);
  const mountedRef = React.useRef(true);
  const startingRef = React.useRef(false);
  const generationRef = React.useRef(0);
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
    if (startingRef.current || recorderRef.current?.state === "recording") return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        "Audio recording is not supported in this browser. Note that recording requires a secure (HTTPS) connection.",
      );
      startingRef.current = false;
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(friendlyMicError(err));
      startingRef.current = false;
      return;
    }

    startingRef.current = false;
    if (!mountedRef.current || generation !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
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

    // Snapshot the cumulative container, not an individual codec fragment.
    // Ordered writes prevent an older checkpoint from replacing a newer one.
    let checkpoints = Promise.resolve();
    let lastCheckpointAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunksRef.current.push(event.data);
      const now = Date.now();
      if (!checkpointRef.current || (recorder.state !== "inactive" && now - lastCheckpointAt < 4500)) return;
      lastCheckpointAt = now;
      const snapshot = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
      const checkpoint = checkpointRef.current;
      checkpoints = checkpoints.then(async () => {
        if (generation !== generationRef.current) return;
        await checkpoint(snapshot);
      }).catch(() => {
        if (mountedRef.current && generation === generationRef.current) {
          setError("This device could not save the recording checkpoint. Recording stopped; keep this page open and download or retry the recording.");
          stop();
        }
      });
    };
    recorder.onstop = async () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      const recorded = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      releaseStream();
      clearTimer();
      // A parent can now persist the final blob without a late checkpoint
      // overwriting its uploaded/review state.
      await checkpoints;
      if (!mountedRef.current || generation !== generationRef.current) return;
      const url = URL.createObjectURL(recorded);
      blobUrlRef.current = url;
      setBlob(recorded);
      setBlobUrl(url);
      setStatus("recorded");
    };

    recorderRef.current = recorder;
    try {
      recorder.start(1000);
    } catch {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      releaseStream();
      setError("Could not start recording with this browser's audio support.");
      return;
    }
    recorder.onerror = () => {
      setError("Recording was interrupted. Any saved audio remains available for review.");
      stop();
    };
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
    // Detach onstop before stopping: reset() during an active recording must
    // discard the take, not let the recorder's async onstop resurrect it as
    // "recorded" after the state below is cleared.
    const recorder = recorderRef.current;
    ++generationRef.current;
    startingRef.current = false;
    if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; }
    stop();
    releaseStream();
    chunksRef.current = [];
    revokeUrl();
    setBlob(null);
    setBlobUrl(null);
    setElapsed(0);
    setError(null);
    setStatus("idle");
  }, [releaseStream, revokeUrl, stop]);

  // Tear down the recorder, stream, timer, and object URL on unmount.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        // Leave dataavailable attached: its final checkpoint is best effort
        // on navigation. The five-second durable snapshot is the recovery floor.
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
