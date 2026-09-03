"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { CommandReceiptBar } from "./command-receipt-bar";
import { FreshnessMarker } from "./freshness-marker";
import { useActionCenter } from "./use-action-center";
import { useWorkCommands } from "./use-work-commands";
import { WorkItemRow } from "./work-item-row";
import type { WorkFreshness, WorkItem } from "./types";

/** One rendered section: a Today group, or a yard. */
export interface WorkSection {
  key: string;
  label: string;
  /** Rendered to the right of the section heading (counts, badges). */
  badge?: React.ReactNode;
  items: WorkItem[];
  /** Shown in place of the list when the section is empty. */
  empty: string;
}

/**
 * The shared body of every work surface.
 *
 * Today, the yard queue and the recommendation filter differ only in which
 * read model they call and how the server grouped the result. Everything
 * downstream of that — keyboard order, command execution, the receipt, the
 * freshness marker, the six states — is this component, once, so the three
 * surfaces cannot drift into three behaviours the way `useFieldWork` and
 * `yardQueue` did.
 *
 * The keyboard order is the flattened render order, which is the server's
 * order: `sortRank`, then hive name, then id (`app/work/build.go` sortItems).
 */
export function WorkSurface({
  title,
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
}: {
  title: string;
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
}) {
  const commands = useWorkCommands();
  const items = React.useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );
  const { focusedId } = useActionCenter({
    items,
    onRun: commands.execute,
    busy: commands.busy,
  });

  const keyboardHints = React.useMemo(() => {
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

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <FreshnessMarker
            freshness={freshness}
            asOf={asOf}
            isFetching={isFetching}
            onRefresh={onRefresh}
          />
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {aside}

      <CommandReceiptBar
        receipt={commands.receipt}
        onRun={commands.execute}
        onDismiss={commands.clear}
        busy={commands.busy}
      />

      {keyboardHints.length > 0 ? (
        <p className="hidden text-[11px] text-muted-foreground md:block">
          Keyboard: <Key>↑/↓</Key> move · <Key>Enter</Key> open hive
          {keyboardHints.map(([key, label]) => (
            <React.Fragment key={key}>
              {" · "}
              <Key>{key}</Key> {label.toLowerCase()}
            </React.Fragment>
          ))}
        </p>
      ) : null}

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
      ) : items.length === 0 ? (
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
              {section.badge}
            </div>
            {section.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{section.empty}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {section.items.map((item) => (
                  <WorkItemRow
                    key={item.id}
                    item={item}
                    focused={item.id === focusedId}
                    onRun={commands.execute}
                    busy={commands.busy}
                  />
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
      {children}
    </kbd>
  );
}
