"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  InspectionFields,
  toEditable,
  toConfirmPayload,
} from "./inspection-fields";
import { EquipmentReview } from "./equipment-review";
import type { HiveSummary } from "./api";
import type { ReviewDraft } from "./capture-store";

export function VisitReview({
  draft,
  hives,
  apiaryId,
  busy,
  onChange,
  onSave,
  nextLabel,
}: {
  draft: ReviewDraft;
  hives: HiveSummary[];
  apiaryId: string;
  busy: boolean;
  onChange: (draft: ReviewDraft) => void;
  onSave: (next: boolean) => void;
  nextLabel?: string;
}) {
  const [editable, setEditable] = useState(
    () => draft.editable ?? toEditable(draft.fields),
  );
  const incomplete =
    draft.scope === "hive" &&
    (editable.feedings.some(
      (feeding) =>
        !feeding.quantity.trim() ||
        !Number.isFinite(Number(feeding.quantity)) ||
        Number(feeding.quantity) <= 0,
    ) ||
      editable.miteCounts.some(
        (count) =>
          !count.mitesCount.trim() ||
          !Number.isInteger(Number(count.mitesCount)) ||
          Number(count.mitesCount) < 0 ||
          ((count.method === "alcohol_wash" || count.method === "sugar_roll") &&
            (!Number.isInteger(Number(count.sampleSize)) ||
              Number(count.sampleSize) <= 0)),
      ));
  const locked = busy || Boolean(draft.pending) || Boolean(draft.receipt);
  const outcome = draft.receipt?.outcomes?.find(
    (item) => item.status === "saved",
  );
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
            : (hives.find((h) => h.id === draft.hiveId)?.positionLabel ??
              "hive history")}
        </h3>
        <p className="mt-1 text-sm">
          Observation and accepted actions were saved together.
        </p>
        <Link
          className="mt-2 inline-flex min-h-11 items-center underline"
          href={
            draft.scope === "apiary"
              ? `/yard/apiaries/${apiaryId}/inspections`
              : `/yard/hives/${draft.hiveId}/timeline`
          }
        >
          View history
        </Link>
        {outcome?.operationIds?.length ? (
          <p className="text-sm">
            {outcome.operationIds.length} equipment change(s) saved.
          </p>
        ) : null}
      </article>
    );
  return (
    <article className="grid min-w-0 gap-4 rounded-xl border bg-card p-4 sm:p-6">
      <h3 className="text-lg font-semibold">
        {draft.scope === "apiary"
          ? "Apiary observation"
          : "Review hive inspection"}
      </h3>
      {draft.fields.evidence && (
        <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
          {draft.fields.evidence}
        </blockquote>
      )}
      {draft.scope === "hive" && (
        <Label className="grid gap-2">
          Hive
          <select
            aria-label="Inspection hive"
            className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base"
            disabled={locked}
            value={draft.hiveId}
            onChange={(e) => onChange({ ...draft, hiveId: e.target.value })}
          >
            <option value="">Choose the hive — match needs review</option>
            {hives.map((hive) => (
              <option key={hive.id} value={hive.id}>
                {hive.positionLabel}
              </option>
            ))}
          </select>
        </Label>
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
            ? "Queued on this device. Waiting for a server receipt."
            : "Confirmation is awaiting a receipt. Retry the same request safely before editing."}
        </p>
      )}
      {incomplete && (
        <p role="alert" className="text-sm text-destructive">
          Complete feeding quantities and mite counts, or remove the unused
          entry before confirming.
        </p>
      )}
      <div className="sticky bottom-[calc(4.5rem+var(--safe-bottom))] z-10 flex flex-wrap gap-2 border-t bg-card py-3 md:bottom-2">
        <Button
          disabled={
            busy || incomplete || (draft.scope === "hive" && !draft.hiveId)
          }
          onClick={() => onSave(false)}
        >
          {busy
            ? "Saving…"
            : draft.pending
              ? "Check / retry confirmation"
              : "Confirm inspection"}
        </Button>
        {nextLabel && !draft.pending && (
          <Button
            variant="outline"
            disabled={busy || incomplete || !draft.hiveId}
            onClick={() => onSave(true)}
          >
            Confirm & next: {nextLabel}
          </Button>
        )}
      </div>
    </article>
  );
}
