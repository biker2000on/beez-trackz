"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import {
  retranscribeRecording,
  selectTranscriptVersion,
  type Transcription,
} from "./api";

export function TranscriptSourceControls({
  transcription,
  disabled,
  onRetranscribe,
}: {
  transcription: Transcription;
  disabled?: boolean;
  onRetranscribe?: () => void;
}) {
  const queryClient = useQueryClient();
  const versions = transcription.versions ?? [];
  const current = transcription.currentVersionId ?? versions[0]?.id ?? "";

  const selectVersion = useMutation({
    mutationFn: (versionId: string) =>
      selectTranscriptVersion(transcription.id, versionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["transcription", transcription.id],
      });
      toast.success("Using selected transcript version");
    },
    onError: (error) => toast.error(error.message),
  });

  const retranscribe = useMutation({
    mutationFn: () => retranscribeRecording(transcription.id),
    onSuccess: () => {
      toast.success("Re-transcription queued");
      onRetranscribe?.();
      void queryClient.invalidateQueries({
        queryKey: ["transcription", transcription.id],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="grid gap-3">
      {versions.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-medium">Transcript versions</p>
          <div className="grid gap-2" role="list">
            {versions.map((version) => {
              const isCurrent = version.id === current;
              const source = `${version.provider}${version.model ? ` / ${version.model}` : ""}`;
              return (
                <div
                  key={version.id}
                  role="listitem"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                >
                  <div className="grid min-w-0 gap-0.5 text-xs">
                    <span className="font-medium">
                      Created {new Date(version.createdAt).toLocaleString()}
                    </span>
                    <span className="truncate text-muted-foreground">
                      Source: {source}
                    </span>
                  </div>
                  {isCurrent ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                      <Check className="size-3.5" /> Current
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled || selectVersion.isPending}
                      onClick={() => selectVersion.mutate(version.id)}
                    >
                      {selectVersion.isPending &&
                      selectVersion.variables === version.id ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      Select
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={disabled || retranscribe.isPending}
        onClick={() => retranscribe.mutate()}
      >
        {retranscribe.isPending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <RefreshCw />
        )}
        {retranscribe.isPending ? "Queueing…" : "Re-transcribe"}
      </Button>
    </div>
  );
}
