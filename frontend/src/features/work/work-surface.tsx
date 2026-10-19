"use client";

import * as React from "react";

import { PageHeader } from "@/components/shell/page-header";
import { useShortcut } from "@/components/shortcuts/provider";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

import { CommandReceiptBar } from "./command-receipt-bar";
import { FreshnessMarker } from "./freshness-marker";
import { HiveCard } from "./hive-card";
import { useActionCenter } from "./use-action-center";
import { useWorkCommands } from "./use-work-commands";
import type { HiveCard as HiveCardData } from "./rollup";
import type { WorkFreshness } from "./types";

/** One rendered section: a bucket (Urgent / This week / Later), or a yard. */
export interface WorkSection {
  key: string;
  label: string;
  cards: HiveCardData[];
  /** Shown in place of the list when the section has no cards. */
  empty?: string;
}

/**
 * The shared body of every work surface.
 *
 * Today, the Visit queue and `?view=all` differ only in which read model
 * they call and how the cards are sectioned. Everything downstream of that —
 * keyboard order, command execution, the receipt, the freshness marker, the
 * stale toggle — is this component, once, so the three surfaces cannot drift
 * into three behaviours.
 *
 * The keyboard order is the flattened render order: cards in section order,
 * items in the server's order within each card.
 */
export function WorkSurface({
  description,
  sections,
  freshness,
  asOf,
  isPending,
  isFetching,
  isError,
  onRefresh,
  emptyAll,
  aside,
  staleCount,
  showStale,
  onToggleStale,
}: {
  description: string;
  sections: WorkSection[];
  freshness: WorkFreshness | undefined;
  asOf: string | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  emptyAll: string;
  aside?: React.ReactNode;
  /** Items hidden (or shown) by the stale rule; 0 hides the toggle. */
  staleCount: number;
  showStale: boolean;
  onToggleStale: () => void;
}) {
  const commands = useWorkCommands();
  const items = React.useMemo(
    () =>
      sections.flatMap((section) =>
        section.cards.flatMap((card) => card.items),
      ),
    [sections],
  );
  const { focusedId, runKey } = useActionCenter({
    items,
    onRun: commands.execute,
    busy: commands.busy,
  });

  // Every distinct letter the items offer, registered with the shortcuts
  // provider so the `?` dialog lists it. The provider owns the keypress and
  // hands it back to the action center, which applies the armed-row guard.
  const letters = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) {
      for (const command of item.commands) {
        if (command.keyboard && !seen.has(command.keyboard)) {
          seen.set(command.keyboard, command.label);
        }
      }
    }
    return [...seen.entries()];
  }, [items]);

  const cardCount = sections.reduce(
    (total, section) => total + section.cards.length,
    0,
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5">
      {letters.map(([key, label]) => (
        <RegisterLetter key={key} letter={key} label={label} runKey={runKey} />
      ))}

      <PageHeader
        subtitle={description}
        status={
          <FreshnessMarker
            freshness={freshness}
            asOf={asOf}
            isFetching={isFetching}
            onRefresh={onRefresh}
          />
        }
      />

      {aside}

      <CommandReceiptBar
        receipt={commands.receipt}
        onRun={commands.execute}
        onDismiss={commands.clear}
        busy={commands.busy}
      />

      {isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <p
          data-testid="work-error"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-6 text-center text-sm"
        >
          Could not load this work list.{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={onRefresh}
          >
            Try again
          </button>
        </p>
      ) : (
        <>
          {staleCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              {showStale
                ? `Showing ${staleCount} stale ${staleCount === 1 ? "item" : "items"} whose evidence is older than a season.`
                : `${staleCount} stale ${staleCount === 1 ? "item is" : "items are"} hidden — evidence older than a season.`}{" "}
              <button
                type="button"
                data-testid="work-stale-toggle"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={onToggleStale}
              >
                {showStale ? "Hide stale" : `Show stale (${staleCount})`}
              </button>
            </p>
          ) : null}

          {cardCount === 0 ? (
            <p
              data-testid="work-empty"
              className="rounded-lg border bg-card px-3 py-10 text-center text-sm text-muted-foreground"
            >
              {emptyAll}
            </p>
          ) : (
            sections.map((section) => (
              <section
                key={section.key}
                data-testid="work-section"
                data-section-key={section.key}
                className="grid gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">{section.label}</h2>
                  {section.cards.length > 0 ? (
                    <Badge
                      variant={section.key === "urgent" ? "destructive" : "outline"}
                    >
                      {section.cards.length}{" "}
                      {section.cards.length === 1 ? "hive" : "hives"}
                    </Badge>
                  ) : null}
                </div>
                {section.cards.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {section.empty ?? "Nothing to do here."}
                  </p>
                ) : (
                  <ul className="grid items-start gap-2 md:grid-cols-2">
                    {section.cards.map((card) => (
                      <HiveCard
                        key={card.key}
                        card={card}
                        focusedId={focusedId}
                        onRun={commands.execute}
                        busy={commands.busy}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}

/** One `?`-dialog entry per command letter; hooks need a fixed call site. */
function RegisterLetter({
  letter,
  label,
  runKey,
}: {
  letter: string;
  label: string;
  runKey: (key: string) => void;
}) {
  useShortcut(letter, `${label} the focused item (↑ ↓ to focus, Enter opens the hive)`, () =>
    runKey(letter),
  );
  return null;
}
