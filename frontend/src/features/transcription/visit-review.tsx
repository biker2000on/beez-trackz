"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { HiveGridPicker } from "@/features/inspections/hive-grid-picker";
import { Textarea } from "@/components/ui/textarea";
import {
  InspectionFields,
  validateInspectionValues,
} from "@/features/inspections/inspection-fields";
import { EquipmentReview } from "./equipment-review";
import type { HiveSummary } from "./api";
import type { ReviewDraft } from "./capture-store";
import { draftValues, toConfirmPayload } from "./review-values";

/**
 * One recording, one inspection: the single-hive and apiary-note review.
 * A whole-apiary walkthrough uses the visit ledger instead.
 */
export function VisitReview({
  draft,
  hives,
  labelFor,
  apiaryId,
  busy,
  error,
  onChange,
  onSave,
  nextLabel,
}: {
  draft: ReviewDraft;
  hives: HiveSummary[];
  labelFor: (hive: HiveSummary) => string;
  apiaryId: string;
  busy: boolean;
  error?: string;
  onChange: (draft: ReviewDraft) => void;
  onSave: (next: boolean) => void;
  nextLabel?: string;
}) {
  const [editable, setEditable] = useState(() => draftValues(draft));
  const problems =
    draft.scope === "hive" ? validateInspectionValues(editable) : {};
  const incomplete = Object.keys(problems).length > 0;
  const locked = busy || Boolean(draft.pending) || Boolean(draft.receipt);
  const hive = hives.find((row) => row.id === draft.hiveId);
  const outcome = draft.receipt?.outcomes?.find((item) => item.status === "saved");
  if (draft.receipt)
    return (
      <article
        className="rounded-xl border border-green-600/30 bg-green-600/5 p-4"
        role="status"
      >
        <h3 className="font-semibold">
          Saved to{" "}
          {draft.scope === "apiary"
            ? "apiary history"
            : hive
              ? labelFor(hive)
              : "hive history"}
        </h3>
        <p className="mt-1 text-sm">
          The inspection and any equipment changes you accepted were saved
          together.
          {outcome?.operationIds?.length
            ? ` ${outcome.operationIds.length} equipment change${outcome.operationIds.length === 1 ? "" : "s"} saved.`
            : ""}
        </p>
        <Link
          className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
          href={
            draft.scope === "apiary"
              ? `/yard/apiaries/${apiaryId}/inspections`
              : `/yard/hives/${draft.hiveId}/timeline`
          }
        >
          View history
        </Link>
      </article>
    );
  const canSave = !busy && !incomplete && (draft.scope !== "hive" || Boolean(draft.hiveId));
  return (
    <article className="grid min-w-0 gap-4 rounded-xl border bg-card p-4 sm:p-6">
      <h3 className="text-lg font-semibold">
        {draft.scope === "apiary"
          ? "Apiary observation"
          : hive
            ? `Review ${labelFor(hive)}`
            : "Review hive inspection"}
      </h3>
      {draft.fields.evidence && (
        <blockquote className="border-l pl-3 text-sm text-muted-foreground">
          {draft.fields.evidence}
        </blockquote>
      )}
      {draft.scope === "hive" && hives.length > 1 && (
        <HiveGridPicker
          hives={hives}
          selected={new Set(draft.hiveId ? [draft.hiveId] : [])}
          labelFor={labelFor}
          legend="Which hive?"
          disabled={locked}
          onSelect={(row) =>
            onChange({
              ...draft,
              hiveId: row.id,
              fields: { ...draft.fields, hiveId: row.id },
            })
          }
        />
      )}
      {draft.scope === "apiary" ? (
        <Label className="grid gap-2">
          Apiary notes
          <Textarea
            rows={5}
            disabled={locked}
            value={draft.fields.notes ?? ""}
            onChange={(e) =>
              onChange({
                ...draft,
                fields: { ...draft.fields, notes: e.target.value },
              })
            }
          />
        </Label>
      ) : (
        <>
          <InspectionFields
            idPrefix={draft.itemKey}
            value={editable}
            disabled={locked}
            errors={problems}
            include={{ feedingsAndQueenEvents: true }}
            onChange={(value) => {
              setEditable(value);
              onChange({
                ...draft,
                editable: value,
                fields: {
                  ...draft.fields,
                  ...toConfirmPayload(value, draft.hiveId),
                },
              });
            }}
          />
          <EquipmentReview
            apiaryId={apiaryId}
            hiveId={draft.hiveId}
            disabled={locked}
            value={draft.fields.equipmentActions ?? []}
            onChange={(equipmentActions) =>
              onChange({
                ...draft,
                fields: { ...draft.fields, equipmentActions },
              })
            }
          />
        </>
      )}
      {draft.pending && (
        <p role="status" className="text-sm">
          {draft.queued
            ? "Saved on this device. It uploads when you're back online."
            : "No reply from Atlas yet. Check again before editing; checking never saves it twice."}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="sticky bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-10 flex flex-wrap gap-2 border-t bg-card py-3 lg:bottom-2">
        {nextLabel && !draft.pending ? (
          <>
            <Button
              className="min-h-12"
              disabled={!canSave}
              onClick={() => onSave(true)}
            >
              {busy ? "Saving…" : `Confirm & next: ${nextLabel}`}
            </Button>
            <Button
              variant="outline"
              className="min-h-12"
              disabled={!canSave}
              onClick={() => onSave(false)}
            >
              Confirm inspection
            </Button>
          </>
        ) : (
          <Button
            className="min-h-12"
            disabled={!canSave}
            onClick={() => onSave(false)}
          >
            {busy ? "Saving…" : draft.pending ? "Check again" : "Confirm inspection"}
          </Button>
        )}
      </div>
    </article>
  );
}
