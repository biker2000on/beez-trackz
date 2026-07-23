"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listApiaries, listHives } from "@/features/transcription/api";
import { RecorderSheet } from "@/features/transcription/audio-recorder";
import { BatchReviewPanel } from "@/features/transcription/batch-review";
import { TranscriptionStatusCard } from "@/features/transcription/status-card";
import { useTranscriptionFlow } from "@/features/transcription/use-transcription-flow";

/**
 * Batch transcription: walk the yard, record one pass over several hives,
 * and review the detected inspections afterwards.
 */
export default function TranscribePage() {
  const [apiaryId, setApiaryId] = React.useState("");
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const apiaries = useQuery({
    queryKey: ["apiaries"],
    queryFn: listApiaries,
  });

  const flow = useTranscriptionFlow({
    mode: "batch",
    ownerType: "apiary",
    ownerId: apiaryId || null,
  });

  const complete = flow.transcription?.status === "complete";

  // Hive options for the match-to-hive selects, fetched once review starts.
  const hivesQuery = useQuery({
    queryKey: ["hives"],
    queryFn: listHives,
    enabled: complete,
  });
  const activeHives = React.useMemo(
    () => (hivesQuery.data ?? []).filter((h) => h.status === "active"),
    [hivesQuery.data],
  );

  const started = flow.uploading || flow.mediaFileId !== null || flow.uploadError !== null;

  const handleUpload = (blob: Blob) => {
    setSheetOpen(false);
    flow.upload(blob);
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Batch transcription
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Record one walkthrough of an apiary and let the AI split it into
          per-hive inspections.
        </p>
      </div>

      {!started && (
        <Card>
          <CardHeader>
            <CardTitle>Record a walkthrough</CardTitle>
            <CardDescription>
              Pick the apiary you are inspecting, then record as you go.
              Mention each hive by name (its position label, e.g.
              &ldquo;Hive A1-2&rdquo;) so the AI can match your notes to the
              right hive.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid max-w-sm gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="batch-apiary">Apiary</Label>
              {apiaries.isPending ? (
                <Skeleton className="h-9 w-full" />
              ) : apiaries.isError ? (
                <p className="text-sm text-destructive">
                  Could not load apiaries.{" "}
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    onClick={() => apiaries.refetch()}
                  >
                    Retry
                  </button>
                </p>
              ) : (
                <Select value={apiaryId || undefined} onValueChange={setApiaryId}>
                  <SelectTrigger id="batch-apiary">
                    <SelectValue placeholder="Select an apiary…" />
                  </SelectTrigger>
                  <SelectContent>
                    {apiaries.data.map((apiary) => (
                      <SelectItem key={apiary.id} value={apiary.id}>
                        {apiary.name} ({apiary.hiveCount} hive
                        {apiary.hiveCount === 1 ? "" : "s"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Button
              type="button"
              size="lg"
              disabled={apiaryId === ""}
              onClick={() => setSheetOpen(true)}
            >
              <Mic />
              Start recording
            </Button>
          </CardContent>
        </Card>
      )}

      {started && !complete && <TranscriptionStatusCard flow={flow} />}

      {complete && flow.transcription && (
        hivesQuery.isPending ? (
          <div className="grid items-start gap-6 lg:grid-cols-[2fr_3fr]">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <BatchReviewPanel
            // Remount the review when a retry produces a new job.
            key={flow.transcription.id}
            transcription={flow.transcription}
            hives={activeHives}
          />
        )
      )}

      <RecorderSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Record apiary walkthrough"
        description="Mention each hive by name as you inspect it. Recording auto-stops after 30 minutes."
        onUpload={handleUpload}
        uploading={flow.uploading}
      />
    </div>
  );
}
