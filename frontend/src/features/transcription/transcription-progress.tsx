"use client";

import { useEffect, useState } from "react";
import { Check, Circle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Transcription } from "./api";

type StepState = "done" | "current" | "waiting";

/**
 * Where a recording is between "Stop & review" and the review list. The step
 * line is a polite status region so a screen reader hears each step once; the
 * elapsed clock is plain text and is never announced.
 */
export function TranscriptionProgress({
  hasAudio,
  uploading,
  uploaded,
  online,
  transcript,
  since,
}: {
  hasAudio: boolean;
  uploading: boolean;
  uploaded: boolean;
  online: boolean;
  transcript?: Transcription;
  /** When the clock starts: the upload time, else the capture time. */
  since: string;
}) {
  const status = transcript?.status;
  const heard = status === "complete";
  const steps: { label: string; state: StepState }[] = [
    { label: "Saved on this device", state: hasAudio ? "done" : "current" },
    {
      label: uploaded
        ? "Uploaded"
        : !online
          ? "Waiting for a connection to upload"
          : "Uploading",
      state: uploaded ? "done" : hasAudio && (uploading || !online) ? "current" : "waiting",
    },
    {
      label: status === "pending" ? "Waiting to turn speech into text" : "Turning speech into text",
      state: heard ? "done" : uploaded ? "current" : "waiting",
    },
    {
      label: "Sorting what you said by hive",
      state: heard ? "current" : "waiting",
    },
  ];
  const current = steps.find((step) => step.state === "current");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const startedAt = new Date(since).getTime();
  const seconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : 0;

  return (
    <section
      aria-label="Recording progress"
      className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p role="status" className="font-medium">
          {current ? `${current.label}…` : "Getting your review ready…"}
        </p>
        {uploaded ? (
          <span className="text-sm tabular-nums text-muted-foreground">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} so far
          </span>
        ) : null}
      </div>
      <ol className="grid gap-2 text-sm">
        {steps.map((step) => (
          <li
            key={step.label}
            className={cn(
              "flex items-center gap-2",
              step.state === "waiting" && "text-muted-foreground",
            )}
          >
            {step.state === "done" ? (
              <Check className="size-4 text-green-700 dark:text-green-400" aria-hidden="true" />
            ) : step.state === "current" ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Circle className="size-4" aria-hidden="true" />
            )}
            <span>{step.label}</span>
            <span className="sr-only">
              {step.state === "done" ? ", done" : step.state === "current" ? ", in progress" : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">
        This page checks every few seconds. You can leave it: the recording
        stays on this device and the review waits for you here.
      </p>
    </section>
  );
}
