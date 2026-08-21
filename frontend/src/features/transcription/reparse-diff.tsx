"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

import {
  applyReparse,
  type ReparseDiff,
  type ReparseProposal,
} from "./api";

function proposalLabel(proposal: ReparseProposal, index: number) {
  const kind =
    proposal.kind === "mite_count" ? "mite count" : proposal.kind;
  return `${kind} ${index + 1} · ${proposal.action}`;
}

const inspectionNestedKinds = new Set([
  "feedings",
  "hiveReference",
  "miteCounts",
  "queenEvents",
]);

function asFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function fieldLabel(field: string) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function fieldValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function proposalChanges(proposal: ReparseProposal) {
  const current = asFields(proposal.current);
  const proposed = asFields(proposal.proposed);
  const fields = new Set([...Object.keys(current), ...Object.keys(proposed)]);

  return Array.from(fields)
    .filter(
      (field) =>
        !field.startsWith("_") &&
        (proposal.kind !== "inspection" || !inspectionNestedKinds.has(field)),
    )
    .map((field) => ({
      field,
      current: current[field],
      proposed: proposed[field],
    }))
    .filter(
      (change) =>
        proposal.action === "create" ||
        fieldValue(change.current) !== fieldValue(change.proposed),
    );
}

export function ReparseDiffPanel({
  mediaFileId,
  versionId,
  diff,
  disabled,
}: {
  mediaFileId: string;
  versionId?: string | null;
  diff: ReparseDiff;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const actionable = diff.proposals.filter(
    (proposal) => proposal.action === "update" || proposal.action === "create",
  );
  const [selected, setSelected] = React.useState<Set<number>>(
    () => new Set(actionable.map((_, index) => index)),
  );

  const apply = useMutation({
    mutationFn: () =>
      applyReparse(
        mediaFileId,
        actionable
          .filter((_, index) => selected.has(index))
          .map((proposal) => ({
            kind: proposal.kind,
            existingId: proposal.existingId,
            hiveId: proposal.hiveId,
            fields: proposal.proposed,
          })),
        versionId,
      ),
    onSuccess: (result) => {
      toast.success(
        `Applied ${result.updated} update${result.updated === 1 ? "" : "s"}, created ${result.created}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["inspections"] });
      void queryClient.invalidateQueries({ queryKey: ["hives"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (!diff.hasExisting) return null;

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">
        This recording already created domain rows. Accept updates below —
        confirmed rows are not rewritten unless you select them.
      </p>
      {actionable.length === 0 ? (
        <p className="text-sm">No changes proposed.</p>
      ) : (
        actionable.map((proposal, index) => {
          const changes = proposalChanges(proposal);
          return (
            <div
              key={`${proposal.kind}-${index}`}
              className="grid gap-2 rounded-md border bg-muted/20 p-3"
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`reparse-${index}`}
                  checked={selected.has(index)}
                  disabled={disabled || apply.isPending}
                  onCheckedChange={(checked) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked === true) next.add(index);
                      else next.delete(index);
                      return next;
                    });
                  }}
                />
                <Label htmlFor={`reparse-${index}`} className="text-sm font-medium">
                  {proposalLabel(proposal, index)}
                </Label>
              </div>
              <div className="grid gap-1 pl-6 text-xs">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 font-medium text-muted-foreground">
                  <span>Current</span>
                  <span aria-hidden="true" />
                  <span>Proposed</span>
                </div>
                {changes.map((change) => (
                  <div key={change.field} className="grid gap-1 border-t py-2">
                    <span className="font-medium">{fieldLabel(change.field)}</span>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                      <span className="break-words text-muted-foreground">
                        {fieldValue(change.current)}
                      </span>
                      <ArrowRight className="size-3.5 text-muted-foreground" />
                      <span className="break-words font-medium">
                        {fieldValue(change.proposed)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
      <Button
        type="button"
        disabled={
          disabled || apply.isPending || selected.size === 0 || actionable.length === 0
        }
        onClick={() => apply.mutate()}
      >
        {apply.isPending ? <Loader2 className="animate-spin" /> : <Check />}
        {apply.isPending ? "Applying…" : "Apply selected updates"}
      </Button>
    </div>
  );
}
