"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ClipboardPenLine, ExternalLink, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InspectionFormDialog } from "@/features/inspections/inspection-form-dialog";
import { cn } from "@/lib/utils";

import { cardSummary, type HiveCard as HiveCardData } from "./rollup";
import { WorkItemRow } from "./work-item-row";
import type { WorkCommand, WorkItem } from "./types";

/**
 * One hive, every open item on it, one primary action.
 *
 * The card states what the hive needs in one line and offers one thing to do
 * about it (Open hive, or Log inspection when that is the top item). The
 * items themselves — their evidence and their Dismiss / Snooze / Refill
 * commands — are behind the disclosure, so a page of thirty hives reads as
 * thirty lines, not ninety chips. Keyboard focus on an item opens its card.
 */
export function HiveCard({
  card,
  focusedId,
  onRun,
  busy,
  hiveHref = (hiveId) => `/yard/hives/${hiveId}`,
}: {
  card: HiveCardData;
  focusedId: string | null;
  onRun: (item: WorkItem, command: WorkCommand) => void;
  busy: boolean;
  hiveHref?: (hiveId: string) => string;
}) {
  const [opened, setOpened] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(false);
  const containsFocus =
    focusedId !== null && card.items.some((item) => item.id === focusedId);
  const open = opened || containsFocus;
  const detailsId = React.useId();
  const urgent = card.priority === "urgent";
  const hasRecommendation = card.items.some(
    (item) => item.sourceType === "recommendation",
  );
  const title = card.hiveName ?? card.items[0]?.title ?? "Item";

  return (
    <li
      data-testid="work-card"
      data-card-key={card.key}
      data-bucket={card.bucket}
      data-priority={card.priority}
      className={cn(
        "grid gap-2 rounded-xl border bg-card p-3",
        urgent && "border-destructive/40",
      )}
    >
      <div className="grid gap-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-base font-semibold leading-tight">
          {hasRecommendation ? (
            <Sparkles
              role="img"
              aria-label="Has recommendations"
              className="size-4 shrink-0 text-primary"
            />
          ) : null}
          {card.hiveId ? (
            <Link
              href={hiveHref(card.hiveId)}
              className="min-w-0 break-words underline-offset-4 hover:underline"
            >
              {title}
            </Link>
          ) : (
            <span className="min-w-0 break-words">{title}</span>
          )}
          {urgent ? (
            <span className="text-xs font-semibold uppercase tracking-wide text-destructive">
              Urgent
            </span>
          ) : null}
        </p>
        {card.apiaryName ? (
          <p className="text-sm text-muted-foreground">{card.apiaryName}</p>
        ) : null}
      </div>

      <p data-testid="work-card-summary" className="break-words text-sm">
        {cardSummary(card)}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {card.primary === "log-inspection" && card.hiveId ? (
          <Button
            type="button"
            data-testid="work-card-primary"
            className="min-h-11 flex-1 sm:flex-none"
            onClick={() => setInspecting(true)}
          >
            <ClipboardPenLine />
            Log inspection
          </Button>
        ) : card.hiveId ? (
          <Button
            asChild
            data-testid="work-card-primary"
            className="min-h-11 flex-1 sm:flex-none"
          >
            <Link href={hiveHref(card.hiveId)}>
              <ExternalLink />
              Open hive
            </Link>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          data-testid="work-card-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          className="min-h-11 gap-1"
          onClick={() => setOpened((value) => !value)}
        >
          {card.items.length} {card.items.length === 1 ? "item" : "items"}
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </Button>
      </div>

      <div id={detailsId} hidden={!open}>
        <ul className="grid gap-1 border-t pt-1">
          {card.items.map((item) => (
            <WorkItemRow
              key={item.id}
              item={item}
              focused={item.id === focusedId}
              onRun={onRun}
              busy={busy}
            />
          ))}
        </ul>
      </div>

      {card.hiveId && inspecting ? (
        <InspectionFormDialog
          open
          onOpenChange={(value) => {
            if (!value) setInspecting(false);
          }}
          hiveId={card.hiveId}
        />
      ) : null}
    </li>
  );
}
