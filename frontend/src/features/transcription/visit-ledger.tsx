"use client";

/**
 * The whole-apiary visit review: one compact row per hive heard in the
 * walkthrough, a chip saying whether it is matched to a hive, and the full
 * fields one tap away. "Confirm N matched" saves every ready row in turn.
 *
 * Keyboard: j / k move between rows, Enter confirms the focused row (or opens
 * it when it still needs a hive), and Ctrl/⌘+Enter confirms all matched rows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useShortcut } from "@/components/shortcuts/provider";
import { HiveGridPicker } from "@/features/inspections/hive-grid-picker";
import {
  InspectionFields,
  validateInspectionValues,
} from "@/features/inspections/inspection-fields";
import { cn } from "@/lib/utils";

import type { HiveSummary } from "./api";
import type { ReviewDraft } from "./capture-store";
import { EquipmentReview } from "./equipment-review";
import {
  draftValues,
  summarizeFields,
  toConfirmPayload,
  visitDay,
} from "./review-values";

export type RowStatus =
  | "saved"
  | "queued"
  | "waiting"
  | "skipped"
  | "needs-hive"
  | "needs-fix"
  | "failed"
  | "ready";

/** Rows "Confirm all" may send: ready, unsaved after an error, or unanswered. */
export function isConfirmable(status: RowStatus): boolean {
  return status === "ready" || status === "failed" || status === "waiting";
}

export function rowStatus(
  draft: ReviewDraft,
  hives: readonly HiveSummary[],
  error?: string,
): RowStatus {
  if (draft.receipt) return "saved";
  if (draft.pending) return draft.queued ? "queued" : "waiting";
  if (draft.skipped) return "skipped";
  if (draft.scope === "hive") {
    // A match to a retired hive (or one outside this apiary) is no match.
    if (!draft.hiveId || !hives.some((hive) => hive.id === draft.hiveId))
      return "needs-hive";
    if (Object.keys(validateInspectionValues(draftValues(draft))).length > 0)
      return "needs-fix";
  }
  return error ? "failed" : "ready";
}

const CHIP: Record<RowStatus, { text: string; className: string }> = {
  saved: {
    text: "Saved",
    className: "border-green-700/30 bg-green-600/10 text-green-800 dark:text-green-300",
  },
  queued: {
    text: "Waiting to upload",
    className: "border-amber-600/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  },
  waiting: {
    text: "Check again",
    className: "border-amber-600/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  },
  skipped: { text: "Skipped", className: "text-muted-foreground" },
  "needs-hive": {
    text: "Needs a hive",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  "needs-fix": {
    text: "Needs a fix",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  failed: {
    text: "Not saved",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  ready: { text: "Matched", className: "border-primary/40 bg-primary/10 text-foreground" },
};

export interface LedgerRun {
  total: number;
  done: number;
  saved: number;
  queued: number;
  failed: number;
  finished: boolean;
  /** Why the run stopped early (lost connection). */
  stopped?: string;
}

function isDialogOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
}

export function VisitLedger({
  drafts,
  hives,
  labelFor,
  apiaryId,
  observedAt,
  timeZone,
  canEdit,
  busy,
  run,
  rowErrors,
  onChange,
  onConfirm,
  onConfirmAll,
}: {
  drafts: ReviewDraft[];
  /** Active hives of this apiary, in grid order. */
  hives: HiveSummary[];
  labelFor: (hive: HiveSummary) => string;
  apiaryId: string;
  observedAt: string;
  timeZone: string;
  canEdit: boolean;
  busy: boolean;
  run: LedgerRun | null;
  rowErrors: Record<string, string>;
  onChange: (draft: ReviewDraft) => void;
  onConfirm: (draft: ReviewDraft) => Promise<void>;
  onConfirmAll: () => Promise<void>;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const statuses = drafts.map((draft) =>
    rowStatus(draft, hives, rowErrors[draft.itemKey]),
  );
  const count = (...kinds: RowStatus[]) =>
    statuses.filter((status) => kinds.includes(status)).length;
  const ready = statuses.filter(isConfirmable).length;
  const needsHive = count("needs-hive");
  const needsFix = count("needs-fix");
  const saved = count("saved");
  const queued = count("queued");
  const skipped = count("skipped");
  const settled = ready === 0 && needsHive === 0 && needsFix === 0;
  const day = visitDay(observedAt, timeZone);

  // Rows that need a hive start open; everything else stays one line.
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        drafts
          .filter((draft) => rowStatus(draft, hives) === "needs-hive")
          .map((draft) => draft.itemKey),
      ),
  );
  const toggle = (itemKey: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });

  const rows = useCallback(
    () =>
      Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-ledger-row]") ?? [],
      ),
    [],
  );
  const focusRow = useCallback(
    (index: number) => {
      const all = rows();
      const target = all[Math.max(0, Math.min(all.length - 1, index))];
      if (!target) return;
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    },
    [rows],
  );
  const move = (delta: number) => {
    const all = rows();
    const active = document.activeElement?.closest<HTMLElement>("[data-ledger-row]");
    const index = active ? all.indexOf(active) : -1;
    focusRow(index === -1 ? (delta > 0 ? 0 : all.length - 1) : index + delta);
  };

  useShortcut("j", "Next hive in the visit review (Enter confirms it)", () => move(1));
  useShortcut("k", "Previous hive in the visit review", () => move(-1));
  // Documented in the ? dialog and Ctrl-K; the key itself is handled below
  // because the shortcut provider ignores modified keys.
  useShortcut("Ctrl/⌘+Enter", "Confirm all matched hives", () => void onConfirmAll(), {
    enabled: canEdit && ready > 0,
  });
  const confirmAllRef = useRef(onConfirmAll);
  useEffect(() => {
    confirmAllRef.current = onConfirmAll;
  }, [onConfirmAll]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      if (event.defaultPrevented || isDialogOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      void confirmAllRef.current();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  async function confirmFromKeyboard(draft: ReviewDraft, index: number) {
    const status = statuses[index];
    if (!isConfirmable(status)) {
      if (status === "needs-hive" || status === "needs-fix") toggle(draft.itemKey);
      return;
    }
    await onConfirm(draft);
    focusRow(index + 1);
  }

  return (
    <section aria-labelledby="visit-ledger-heading" className="grid gap-3">
      <h2 id="visit-ledger-heading" className="text-lg font-semibold">
        {drafts.length} {drafts.length === 1 ? "entry" : "entries"} from this walkthrough
      </h2>

      <ol ref={listRef} className="grid gap-2">
        {drafts.map((draft, index) => (
          <LedgerRow
            key={draft.itemKey}
            draft={draft}
            status={statuses[index]}
            error={rowErrors[draft.itemKey]}
            hives={hives}
            labelFor={labelFor}
            apiaryId={apiaryId}
            claimedBy={(hiveId) =>
              drafts.findIndex(
                (other) =>
                  other.itemKey !== draft.itemKey &&
                  other.scope === "hive" &&
                  other.hiveId === hiveId &&
                  !other.skipped,
              )
            }
            open={expanded.has(draft.itemKey)}
            onToggle={() => toggle(draft.itemKey)}
            busy={busy}
            canEdit={canEdit}
            onChange={onChange}
            onConfirm={() => onConfirm(draft)}
            onEnter={() => void confirmFromKeyboard(draft, index)}
          />
        ))}
      </ol>

      {settled && saved + queued > 0 ? (
        <section
          aria-labelledby="visit-summary-heading"
          className="grid gap-2 rounded-xl border border-green-700/30 bg-green-600/5 p-4"
          role="status"
        >
          <h3 id="visit-summary-heading" className="font-semibold">
            Visit recorded
          </h3>
          <p className="text-sm">
            {[
              `${saved} saved`,
              queued ? `${queued} waiting to upload` : null,
              skipped ? `${skipped} skipped` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <Link
            href={`/yard/apiaries/${apiaryId}/timeline?date=${day.iso}`}
            className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
          >
            Open {day.label} on the timeline
          </Link>
        </section>
      ) : null}

      {!settled || run?.stopped ? (
        <div className="sticky bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-20 grid gap-2 rounded-xl border bg-card p-3 shadow-lg lg:bottom-4">
          {run && !run.finished ? (
            <div className="grid gap-1">
              <p role="status" className="text-sm font-medium">
                Saving… {run.done} of {run.total} done
              </p>
              <progress
                className="h-2 w-full overflow-hidden rounded-full accent-primary"
                value={run.done}
                max={run.total}
                aria-label="Visit saving progress"
              />
            </div>
          ) : run?.finished ? (
            <p role="status" className="text-sm">
              {run.saved} of {run.total} saved
              {run.queued ? ` · ${run.queued} waiting to upload` : ""}
              {run.failed ? ` · ${run.failed} not saved, see the rows marked "Not saved"` : ""}
              {run.stopped ? `. ${run.stopped}` : ""}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              className="min-h-12 flex-1 sm:flex-none"
              disabled={!canEdit || busy || ready === 0}
              onClick={() => void onConfirmAll()}
            >
              {busy && run && !run.finished
                ? "Saving…"
                : `Confirm ${ready} matched`}
            </Button>
            <p className="text-sm text-muted-foreground">
              {[
                needsHive ? `${needsHive} ${needsHive === 1 ? "needs" : "need"} a hive` : null,
                needsFix ? `${needsFix} ${needsFix === 1 ? "needs" : "need"} a fix` : null,
                saved ? `${saved} saved` : null,
                skipped ? `${skipped} skipped` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Every row is matched"}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LedgerRow({
  draft,
  status,
  error,
  hives,
  labelFor,
  apiaryId,
  claimedBy,
  open,
  onToggle,
  busy,
  canEdit,
  onChange,
  onConfirm,
  onEnter,
}: {
  draft: ReviewDraft;
  status: RowStatus;
  error?: string;
  hives: HiveSummary[];
  labelFor: (hive: HiveSummary) => string;
  apiaryId: string;
  /** Index of another row matched to this hive, or -1. */
  claimedBy: (hiveId: string) => number;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  canEdit: boolean;
  onChange: (draft: ReviewDraft) => void;
  onConfirm: () => Promise<void>;
  onEnter: () => void;
}) {
  const hive = hives.find((row) => row.id === draft.hiveId);
  const name =
    draft.scope === "apiary" ? "Apiary" : hive ? labelFor(hive) : "No hive yet";
  const heard = draft.fields.hiveReference?.trim();
  const summary =
    draft.scope === "apiary"
      ? draft.fields.notes?.trim() || "Apiary note"
      : summarizeFields(draft.fields) || "Nothing recorded for this hive yet";
  const duplicate = hive ? claimedBy(hive.id) : -1;
  const locked = busy || !canEdit || Boolean(draft.pending) || Boolean(draft.receipt);
  const chip = CHIP[status];
  const panelId = `ledger-${draft.itemKey}-panel`;

  return (
    <li
      data-ledger-row
      tabIndex={-1}
      aria-label={`${name}, ${chip.text}. ${summary}`}
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.target !== event.currentTarget ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        onEnter();
      }}
      className={cn(
        "grid min-w-0 rounded-xl border bg-card outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        status === "skipped" && "bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pr-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2 text-left hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="w-16 shrink-0 font-semibold tabular-nums">
            {draft.scope === "apiary" ? "Apiary" : hive ? hive.positionLabel : "?"}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm",
                status === "skipped" && "text-muted-foreground line-through",
              )}
            >
              {summary}
            </span>
            {status === "needs-hive" && heard ? (
              <span className="block truncate text-xs text-muted-foreground">
                Heard “{heard}”
              </span>
            ) : duplicate >= 0 && status !== "saved" ? (
              <span className="block truncate text-xs text-destructive">
                Same hive as row {duplicate + 1}
              </span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        <Badge variant="outline" className={cn("shrink-0", chip.className)}>
          {chip.text}
        </Badge>
      </div>

      {open ? (
        <div id={panelId} className="grid gap-4 border-t p-3 sm:p-4">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {draft.receipt ? (
            <p className="text-sm">
              Saved.{" "}
              {draft.scope === "hive" ? (
                <Link
                  className="inline-flex min-h-11 items-center underline underline-offset-4"
                  href={`/yard/hives/${draft.hiveId}/timeline`}
                >
                  Open {name}
                </Link>
              ) : null}
            </p>
          ) : (
            <RowEditor
              draft={draft}
              hives={hives}
              labelFor={labelFor}
              apiaryId={apiaryId}
              claimedBy={claimedBy}
              locked={locked}
              onChange={onChange}
            />
          )}
          {draft.pending ? (
            <p role="status" className="text-sm">
              {draft.queued
                ? "Saved on this device. It uploads when you're back online."
                : "No reply from Atlas yet. Check again before editing; checking never saves it twice."}
            </p>
          ) : null}
          {!draft.receipt && canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-12"
                disabled={busy || !isConfirmable(status)}
                onClick={() => void onConfirm()}
              >
                {status === "waiting" ? "Check again" : `Confirm ${name}`}
              </Button>
              {!draft.pending ? (
                <Button
                  variant="outline"
                  className="min-h-12"
                  disabled={busy}
                  onClick={() => onChange({ ...draft, skipped: !draft.skipped })}
                >
                  {draft.skipped ? "Include in this visit" : "Skip this entry"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RowEditor({
  draft,
  hives,
  labelFor,
  apiaryId,
  claimedBy,
  locked,
  onChange,
}: {
  draft: ReviewDraft;
  hives: HiveSummary[];
  labelFor: (hive: HiveSummary) => string;
  apiaryId: string;
  claimedBy: (hiveId: string) => number;
  locked: boolean;
  onChange: (draft: ReviewDraft) => void;
}) {
  const [values, setValues] = useState(() => draftValues(draft));
  const matched = hives.some((hive) => hive.id === draft.hiveId);
  const [choosing, setChoosing] = useState(!matched);
  const hive = hives.find((row) => row.id === draft.hiveId);

  if (draft.scope === "apiary")
    return (
      <Label className="grid gap-2">
        Apiary notes
        <Textarea
          rows={3}
          disabled={locked}
          value={draft.fields.notes ?? ""}
          onChange={(event) =>
            onChange({ ...draft, fields: { ...draft.fields, notes: event.target.value } })
          }
        />
      </Label>
    );

  return (
    <>
      {draft.fields.evidence ? (
        <blockquote className="border-l pl-3 text-sm text-muted-foreground">
          {draft.fields.evidence}
        </blockquote>
      ) : null}
      {choosing || !hive ? (
        <HiveGridPicker
          hives={hives}
          selected={new Set(draft.hiveId ? [draft.hiveId] : [])}
          labelFor={labelFor}
          noteFor={(row) => {
            const other = claimedBy(row.id);
            return other >= 0 ? `row ${other + 1}` : undefined;
          }}
          legend={
            draft.fields.hiveReference
              ? `Which hive is “${draft.fields.hiveReference}”?`
              : "Which hive is this?"
          }
          disabled={locked}
          onSelect={(row) => {
            setChoosing(false);
            onChange({ ...draft, hiveId: row.id, fields: { ...draft.fields, hiveId: row.id } });
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Hive <strong>{labelFor(hive)}</strong>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => setChoosing(true)}
          >
            Change hive
          </Button>
        </div>
      )}
      <InspectionFields
        idPrefix={draft.itemKey}
        value={values}
        disabled={locked}
        errors={validateInspectionValues(values)}
        include={{ feedingsAndQueenEvents: true }}
        onChange={(next) => {
          setValues(next);
          onChange({
            ...draft,
            editable: next,
            fields: { ...draft.fields, ...toConfirmPayload(next, draft.hiveId) },
          });
        }}
      />
      <EquipmentReview
        apiaryId={apiaryId}
        hiveId={draft.hiveId}
        disabled={locked}
        value={draft.fields.equipmentActions ?? []}
        onChange={(equipmentActions) =>
          onChange({ ...draft, fields: { ...draft.fields, equipmentActions } })
        }
      />
    </>
  );
}
