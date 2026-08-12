"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

import {
  confirmTranscription,
  parseTranscription,
  type HiveSummary,
  type ParsedResult,
  type Transcription,
} from "./api";
import {
  InspectionFields,
  toConfirmPayload,
  toEditable,
  type EditableInspection,
} from "./inspection-fields";

interface BatchItem {
  include: boolean;
  hiveId: string;
  hiveReference: string | null;
  fields: EditableInspection;
}

function toItems(
  parsed: ParsedResult | undefined,
  hives: HiveSummary[],
): BatchItem[] {
  return (parsed?.inspections ?? []).map((inspection) => {
    // The server matcher considers all non-archived hives, but the select
    // only offers active ones — drop a preseed the user couldn't see or
    // re-pick (e.g. a dead hive), so the card visibly asks for a hive.
    const matched = inspection.matchedHiveId ?? "";
    const selectable = hives.some((hive) => hive.id === matched);
    return {
      include: true,
      hiveId: selectable ? matched : "",
      hiveReference: inspection.hiveReference ?? null,
      fields: toEditable(inspection),
    };
  });
}

interface BatchReviewPanelProps {
  transcription: Transcription;
  /** Active hives to match against (options for the hive selects). */
  hives: HiveSummary[];
}

/**
 * Batch review: raw transcript + detected count on the left; one card per
 * detected inspection on the right with include checkbox, match-to-hive
 * select (preseeded from the fuzzy match), and compact editable fields.
 * Every included inspection must be matched before Confirm All.
 */
export function BatchReviewPanel({
  transcription,
  hives,
}: BatchReviewPanelProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [parsed, setParsed] = React.useState<ParsedResult | undefined>(
    transcription.parsed,
  );
  const [parseError, setParseError] = React.useState<string | undefined>(
    transcription.parseError,
  );
  const [items, setItems] = React.useState<BatchItem[]>(() =>
    toItems(transcription.parsed, hives),
  );

  const reparse = useMutation({
    mutationFn: () => parseTranscription(transcription.id, "batch"),
    onSuccess: (result) => {
      setParsed(result);
      setParseError(undefined);
      setItems(toItems(result, hives));
      toast.success("Transcript re-parsed");
    },
    onError: (error) => toast.error(error.message),
  });

  const included = items.filter((item) => item.include);
  const unmatchedCount = included.filter((item) => item.hiveId === "").length;

  const confirm = useMutation({
    mutationFn: () =>
      confirmTranscription(
        transcription.id,
        "batch",
        included.map((item) => toConfirmPayload(item.fields, item.hiveId)),
      ),
    onSuccess: (result) => {
      toast.success(
        `Created ${result.inspectionIds.length} inspection${result.inspectionIds.length === 1 ? "" : "s"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["hives"] });
      void queryClient.invalidateQueries({ queryKey: ["inspections"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      router.push("/dashboard");
    },
    onError: (error) => toast.error(error.message),
  });

  const updateItem = (index: number, patch: Partial<BatchItem>) =>
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  const rawText = parsed?.rawText ?? transcription.transcriptionText ?? "";
  const detected = items.length;

  return (
    <ShortcutForm
      className="grid items-start gap-6 lg:grid-cols-[2fr_3fr]"
      onSubmit={(event) => {
        event.preventDefault();
        if (included.length > 0 && unmatchedCount === 0) confirm.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Raw transcript</CardTitle>
            <Badge variant="secondary">
              {detected} inspection{detected === 1 ? "" : "s"} detected
            </Badge>
          </div>
          <CardDescription>
            What the AI heard across the whole recording.
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

      <div className="grid gap-4">
        {items.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No inspections were detected in this recording. Try re-parsing,
              or re-record and mention each hive by name.
            </CardContent>
          </Card>
        )}

        {items.map((item, index) => (
          <Card key={index} className={item.include ? "" : "opacity-60"}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`batch-${index}-include`}
                    checked={item.include}
                    disabled={confirm.isPending}
                    onCheckedChange={(checked) =>
                      updateItem(index, { include: checked === true })
                    }
                  />
                  <Label htmlFor={`batch-${index}-include`}>
                    Inspection {index + 1}
                  </Label>
                </div>
                {item.hiveReference && (
                  <Badge variant="outline">
                    Heard: &ldquo;{item.hiveReference}&rdquo;
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`batch-${index}-hive`} className="text-xs">
                  Match to Hive
                </Label>
                <Select
                  value={item.hiveId || undefined}
                  disabled={confirm.isPending}
                  onValueChange={(v) => updateItem(index, { hiveId: v })}
                >
                  <SelectTrigger
                    id={`batch-${index}-hive`}
                    className={
                      item.include && item.hiveId === ""
                        ? "h-8 border-destructive text-xs"
                        : "h-8 text-xs"
                    }
                  >
                    <SelectValue placeholder="Select a hive…" />
                  </SelectTrigger>
                  <SelectContent>
                    {hives.map((hive) => (
                      <SelectItem key={hive.id} value={hive.id}>
                        {hive.apiaryName} · {hive.positionLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Separator />
              <InspectionFields
                value={item.fields}
                onChange={(fields) => updateItem(index, { fields })}
                dense
                idPrefix={`batch-${index}`}
                disabled={confirm.isPending || !item.include}
              />
            </CardContent>
          </Card>
        ))}

        {items.length > 0 && (
          <div className="grid gap-2">
            {unmatchedCount > 0 && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4" />
                {unmatchedCount} included inspection
                {unmatchedCount === 1 ? " needs" : "s need"} a hive before
                confirming.
              </p>
            )}
            <Button
              type="submit"
              disabled={
                confirm.isPending ||
                reparse.isPending ||
                included.length === 0 ||
                unmatchedCount > 0
              }
            >
              {confirm.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              {confirm.isPending
                ? "Creating…"
                : `Confirm All (${included.length})`}
            </Button>
          </div>
        )}
      </div>
    </ShortcutForm>
  );
}
