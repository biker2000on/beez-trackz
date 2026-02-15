"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { formatDuration, AUDIO_MIME_TYPE, MAX_RECORDING_DURATION } from "@/lib/audio-utils";
import { Mic, Square, RotateCcw, Upload } from "lucide-react";

type RecordingState = "idle" | "recording" | "stopped";

interface AudioRecorderProps {
  mode: "single" | "batch";
  hiveId?: string;
  hiveName?: string;
  onComplete: (audioBlob: Blob, mode: string) => void;
}

export function AudioRecorder({ mode, hiveId, hiveName, onComplete }: AudioRecorderProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [audioUrl]);

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: AUDIO_MIME_TYPE,
      });

      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: AUDIO_MIME_TYPE });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setState("stopped");

        // Stop and cleanup stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setState("recording");
      setDuration(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setDuration((prev) => {
          const newDuration = prev + 1;
          // Auto-stop at max duration
          if (newDuration >= MAX_RECORDING_DURATION) {
            stopRecording();
          }
          return newDuration;
        });
      }, 1000);
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          setError(
            "Microphone access denied. Please allow microphone access in your browser settings."
          );
        } else if (err.name === "NotFoundError") {
          setError("No microphone found. Please connect a microphone and try again.");
        } else {
          setError(`Failed to start recording: ${err.message}`);
        }
      } else {
        setError("Failed to start recording. Please try again.");
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && state === "recording") {
      mediaRecorderRef.current.stop();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const reRecord = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioBlob(null);
    setAudioUrl(null);
    setState("idle");
    setDuration(0);
    setError(null);
  };

  const handleUpload = () => {
    if (audioBlob) {
      onComplete(audioBlob, mode);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 p-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">
          {mode === "batch" ? "Recording for all hives" : `Recording for ${hiveName || "Hive"}`}
        </h2>
        {state === "recording" && (
          <div className="text-sm text-muted-foreground">
            Recording will auto-stop after 30 minutes
          </div>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="w-full max-w-md p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Recording State */}
      {state === "idle" && (
        <div className="flex flex-col items-center gap-4">
          <Button
            onClick={startRecording}
            size="lg"
            className="h-24 w-24 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg"
          >
            <Mic className="h-10 w-10" />
          </Button>
          <p className="text-sm text-muted-foreground">Tap to start recording</p>
        </div>
      )}

      {state === "recording" && (
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <Button
              onClick={stopRecording}
              size="lg"
              className="h-24 w-24 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg recording-pulse"
            >
              <Mic className="h-10 w-10" />
            </Button>
          </div>
          <div className="text-3xl font-mono font-bold">{formatDuration(duration)}</div>
          <Button onClick={stopRecording} variant="outline" size="lg">
            <Square className="h-5 w-5 mr-2 fill-current" />
            Stop Recording
          </Button>
        </div>
      )}

      {state === "stopped" && audioUrl && (
        <div className="flex flex-col items-center gap-4 w-full max-w-md">
          <div className="text-2xl font-mono font-bold">{formatDuration(duration)}</div>
          <audio controls src={audioUrl} className="w-full" />
          <div className="flex gap-3 w-full">
            <Button onClick={reRecord} variant="outline" className="flex-1">
              <RotateCcw className="h-4 w-4 mr-2" />
              Re-record
            </Button>
            <Button onClick={handleUpload} className="flex-1">
              <Upload className="h-4 w-4 mr-2" />
              Upload
            </Button>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes recording-pulse {
          0%,
          100% {
            box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7);
          }
          50% {
            box-shadow: 0 0 0 20px rgba(239, 68, 68, 0);
          }
        }

        .recording-pulse {
          animation: recording-pulse 2s infinite;
        }
      `}</style>
    </div>
  );
}
