"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getHive } from "@/features/transcription/api";
import { RecorderSheet } from "@/features/transcription/audio-recorder";
import { SingleReviewPanel } from "@/features/transcription/single-review";
import { TranscriptionStatusCard } from "@/features/transcription/status-card";
import { useTranscriptionFlow } from "@/features/transcription/use-transcription-flow";

/**
 * Single-hive transcription: record an inspection for this hive, wait for
 * the AI transcription, then review and confirm one inspection.
 */
export default function HiveTranscribePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = React.use(params);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const hive = useQuery({
    queryKey: ["hive", id],
    queryFn: () => getHive(id),
  });

  const flow = useTranscriptionFlow({
    mode: "single",
    ownerType: "hive",
    ownerId: id,
  });

  const complete = flow.transcription?.status === "complete";
  const started =
    flow.uploading || flow.mediaFileId !== null || flow.uploadError !== null;

  const handleUpload = (blob: Blob) => {
    setSheetOpen(false);
    flow.upload(blob);
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="grid gap-2">
        <Link
          href={`/hives/${id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to hive
        </Link>
        {hive.isPending ? (
          <Skeleton className="h-8 w-64" />
        ) : hive.isError ? (
          <h1 className="text-2xl font-bold tracking-tight">
            Voice inspection
          </h1>
        ) : (
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Voice inspection · {hive.data.positionLabel}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {hive.data.apiaryName}
            </p>
          </div>
        )}
      </div>

      {!started && (
        <Card>
          <CardHeader>
            <CardTitle>Record your inspection</CardTitle>
            <CardDescription>
              Describe what you see out loud — queen, brood, stores,
              temperament, pests, treatments — and the AI will fill in the
              inspection form for you to review.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" size="lg" onClick={() => setSheetOpen(true)}>
              <Mic />
              Start recording
            </Button>
          </CardContent>
        </Card>
      )}

      {started && !complete && <TranscriptionStatusCard flow={flow} />}

      {complete && flow.transcription && (
        <SingleReviewPanel
          // Remount the review when a retry produces a new job.
          key={flow.transcription.id}
          transcription={flow.transcription}
          hiveId={id}
        />
      )}

      <RecorderSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Record inspection"
        description="Speak naturally about this hive. Recording auto-stops after 30 minutes."
        onUpload={handleUpload}
        uploading={flow.uploading}
      />
    </div>
  );
}
