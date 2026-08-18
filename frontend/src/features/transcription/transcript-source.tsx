"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const current =
    transcription.currentVersionId ?? versions[0]?.id ?? "";

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
        <div className="grid gap-1.5">
          <Label className="text-xs">Transcript version</Label>
          <Select
            value={current || undefined}
            disabled={disabled || selectVersion.isPending}
            onValueChange={(value) => selectVersion.mutate(value)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Select a version" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((version) => (
                <SelectItem key={version.id} value={version.id}>
                  {new Date(version.producedAt).toLocaleString()} ·{" "}
                  {version.provider}
                  {version.model ? ` / ${version.model}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
