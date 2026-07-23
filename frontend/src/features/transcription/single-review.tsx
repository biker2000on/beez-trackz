"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  confirmTranscription,
  parseTranscription,
  type ParsedResult,
  type Transcription,
} from "./api";
import {
  InspectionFields,
  toConfirmPayload,
  toEditable,
  type EditableInspection,
} from "./inspection-fields";

interface SingleReviewPanelProps {
  transcription: Transcription;
  /** The hive the recording belongs to (owner of the media file). */
  hiveId: string;
}

/**
 * Single-hive review: raw transcript with "Re-parse with AI" on the left,
 * editable inspection card on the right (stacked on mobile). Confirm creates
 * the inspection and returns to the hive page.
 */
export function SingleReviewPanel({
  transcription,
  hiveId,
}: SingleReviewPanelProps) {
  const router = useRouter();
  const [parsed, setParsed] = React.useState<ParsedResult | undefined>(
    transcription.parsed,
  );
  const [parseError, setParseError] = React.useState<string | undefined>(
    transcription.parseError,
  );
  const [fields, setFields] = React.useState<EditableInspection>(() =>
    toEditable(transcription.parsed?.inspections[0]),
  );

  const reparse = useMutation({
    mutationFn: () => parseTranscription(transcription.id, "single"),
    onSuccess: (result) => {
      setParsed(result);
      setParseError(undefined);
      setFields(toEditable(result.inspections[0]));
      toast.success("Transcript re-parsed");
    },
    onError: (error) => toast.error(error.message),
  });

  const confirm = useMutation({
    mutationFn: () =>
      confirmTranscription(transcription.id, "single", [
        toConfirmPayload(fields, hiveId),
      ]),
    onSuccess: () => {
      toast.success("Inspection created");
      router.push(`/hives/${hiveId}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const rawText = parsed?.rawText ?? transcription.transcriptionText ?? "";

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Raw transcript</CardTitle>
          <CardDescription>
            What the AI heard. Re-parse if the extracted fields look off.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-secondary/50 p-3 text-sm">
            {rawText || "No transcript text."}
          </p>
          {parseError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p>AI parsing failed: {parseError}</p>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={reparse.isPending || confirm.isPending}
            onClick={() => reparse.mutate()}
          >
            {reparse.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Sparkles />
            )}
            {reparse.isPending ? "Re-parsing…" : "Re-parse with AI"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inspection details</CardTitle>
          <CardDescription>
            Review and edit the extracted fields before saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <InspectionFields
            value={fields}
            onChange={setFields}
            idPrefix="single"
            disabled={confirm.isPending}
          />
          <Button
            type="button"
            disabled={confirm.isPending || reparse.isPending}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Check />
            )}
            {confirm.isPending ? "Creating…" : "Confirm & Create Inspection"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
