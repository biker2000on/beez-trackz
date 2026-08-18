"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
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
        actionable.map((proposal, index) => (
          <div key={`${proposal.kind}-${index}`} className="flex items-start gap-2">
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
            <Label htmlFor={`reparse-${index}`} className="text-sm font-normal">
              {proposalLabel(proposal, index)}
            </Label>
          </div>
        ))
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
