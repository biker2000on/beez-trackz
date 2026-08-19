"use client";

import * as React from "react";
import { AlertCircle, Mic, RotateCcw, Square, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import {
  MAX_RECORDING_SECONDS,
  formatElapsed,
  useAudioRecorder,
} from "./use-audio-recorder";

interface AudioRecorderProps {
  /** Called with the finished recording when the user taps Upload. */
  onUpload: (blob: Blob) => void;
  uploading?: boolean;
}

/**
 * Record / stop / playback / re-record / upload. Big pulsing record button,
 * live elapsed timer, 30-minute auto-stop, friendly mic errors.
 */
export function AudioRecorder({ onUpload, uploading }: AudioRecorderProps) {
  const recorder = useAudioRecorder();

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      {recorder.error && (
        <div className="flex w-full items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p>{recorder.error}</p>
        </div>
      )}

      {recorder.status !== "recorded" && (
        <>
          <button
            type="button"
            onClick={() =>
              recorder.status === "recording"
                ? recorder.stop()
                : void recorder.start()
            }
            aria-label={
              recorder.status === "recording"
                ? "Stop recording"
                : "Start recording"
            }
            className={cn(
              "relative flex size-24 items-center justify-center rounded-full text-primary-foreground shadow-lg transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              recorder.status === "recording"
                ? "bg-destructive hover:bg-destructive/90"
                : "bg-primary hover:bg-primary/90",
            )}
          >
            {recorder.status === "recording" && (
              // DESIGN.md: motion is disabled when reduced motion is
              // preferred. Without the fallback the ping freezes mid-pulse
              // and the only "recording" cue is the button colour.
              <span
                aria-hidden
                className="absolute inset-0 animate-ping rounded-full bg-destructive/40 motion-reduce:animate-none motion-reduce:ring-2 motion-reduce:ring-destructive"
              />
            )}
            {recorder.status === "recording" ? (
              <Square className="size-9 fill-current" />
            ) : (
              <Mic className="size-10" />
            )}
          </button>

          <div className="text-center">
            <p className="font-mono text-2xl tabular-nums">
              {formatElapsed(recorder.elapsed)}
            </p>
            <p className="text-sm text-muted-foreground">
              {recorder.status === "recording"
                ? `Recording — tap to stop (auto-stops at ${formatElapsed(MAX_RECORDING_SECONDS)})`
                : "Tap to start recording"}
            </p>
          </div>
        </>
      )}

      {recorder.status === "recorded" && recorder.blobUrl && (
        <div className="flex w-full flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Recorded {formatElapsed(recorder.elapsed)}. Listen back before
            uploading.
          </p>
          <audio controls src={recorder.blobUrl} className="w-full" />
          <div className="flex w-full gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={uploading}
              onClick={recorder.reset}
            >
              <RotateCcw />
              Re-record
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={uploading}
              onClick={() => recorder.blob && onUpload(recorder.blob)}
            >
              <Upload />
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface RecorderSheetProps extends AudioRecorderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
}

/** Bottom-drawer wrapper so pages can launch the recorder from a button. */
export function RecorderSheet({
  open,
  onOpenChange,
  title,
  description,
  onUpload,
  uploading,
}: RecorderSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <AudioRecorder onUpload={onUpload} uploading={uploading} />
      </SheetContent>
    </Sheet>
  );
}
