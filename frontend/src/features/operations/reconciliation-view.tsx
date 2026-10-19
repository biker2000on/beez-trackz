"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGnuCashRows,
  useGnuCashSettings,
  useIgnoreGnuCashRow,
  usePushGnuCashRow,
  useRunGnuCashSync,
  type GnuCashRow,
} from "@/features/settings/api";
import {
  describeRequestError,
  errorMessage,
  humanize,
  formatTimestamp,
  isFolioConfigured,
} from "@/features/settings/gnucash-format";

import { AdminReportGate } from "./reports-nav";

function ConflictRow({
  row,
  onPush,
  onIgnore,
  busy,
  canPush,
}: {
  row: GnuCashRow;
  onPush: (id: string) => void;
  onIgnore: (id: string) => void;
  busy: boolean;
  /** False while sync is disabled: the server refuses this write too. */
  canPush: boolean;
}) {
  return (
    <li className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">
          {humanize(row.entityType)}
          {row.summary ? ` — ${row.summary}` : ""}
        </span>
        <span className="text-xs text-muted-foreground">{row.externalId}</span>
      </div>
      <p className="text-xs text-muted-foreground">{row.lastError}</p>
      {row.bookRetired ? (
        <p className="text-xs text-muted-foreground">
          Belongs to retired book {row.bookLabel}. Atlas no longer writes
          there, so it can only be ignored here.
        </p>
      ) : null}
      {row.remoteEnterDate ? (
        <p className="text-xs text-muted-foreground">
          Changed in Folio {formatTimestamp(row.remoteEnterDate)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !canPush || row.bookRetired}
          title={
            canPush
              ? undefined
              : "Enable Folio sync before writing to the book"
          }
          onClick={() => onPush(row.id)}
        >
          Push local again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onIgnore(row.id)}
        >
          Ignore
        </Button>
      </div>
    </li>
  );
}

/**
 * `/insights/reconciliation` — what the Folio feed did and what disagrees
 * (design 2026-09-03 §6.3, S6).
 *
 * The configuration this reports on — Folio credentials, the book, the
 * account mapping — has exactly one editor, and it is not here: it is Admin
 * and Integrations. What lives here is the run and its outcome, including the
 * two ways an operator ends a conflict, because resolving a conflict *is* the
 * reconciliation rather than a change to the integration's settings.
 */
function ReconciliationReport() {
  const settings = useGnuCashSettings();
  const rows = useGnuCashRows();
  const sync = useRunGnuCashSync();
  const push = usePushGnuCashRow();
  const ignore = useIgnoreGnuCashRow();

  const busy = push.isPending || ignore.isPending;
  const counts = rows.data?.counts ?? {};
  const conflicts = rows.data?.conflicts ?? [];
  const failures = rows.data?.failures ?? [];
  const syncEnabled = settings.data?.syncEnabled === true;
  const configured = settings.data ? isFolioConfigured(settings.data) : false;
  // The column is stamped on every run, including one whose pull failed and
  // which pushed nothing, so it is an attempt time.
  const lastAttemptAt =
    settings.data?.lastSyncAttemptAt ?? settings.data?.lastSyncedAt ?? null;

  return (
    <>
      {settings.isPending || rows.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : settings.isError || rows.isError ? (
          <div
            role="alert"
            className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <p className="flex items-center gap-1 font-medium">
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              Could not load the reconciliation report
            </p>
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {settings.isError ? (
                <li>
                  Folio sync settings:{" "}
                  {describeRequestError(settings.error)}
                </li>
              ) : null}
              {rows.isError ? (
                <li>
                  Sync entries: {describeRequestError(rows.error)}
                </li>
              ) : null}
            </ul>
            <p>
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => {
                  void settings.refetch();
                  void rows.refetch();
                }}
              >
                Try again
              </button>
            </p>
          </div>
        ) : !configured ? (
          <div className="grid gap-2 rounded-md border p-3 text-sm">
            <p className="font-medium">Folio sync is not set up</p>
            <p className="text-xs text-muted-foreground">
              {settings.data?.baseUrl
                ? "No API token is saved."
                : "No Folio server URL is saved."}{" "}
              Nothing has been pushed, so there is nothing to reconcile yet.
              Connect a Folio book in Access &amp; integrations to start.
            </p>
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href="/admin#gnucash">
                  Set up Folio
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={sync.isPending || !syncEnabled}
                title={
                  syncEnabled
                    ? undefined
                    : "Sync is disabled. The server refuses every push until you enable it."
                }
                onClick={() =>
                  sync.mutate(undefined, {
                    onSuccess: (report) => {
                      toast.success(
                        `Pushed ${report.created} new, updated ${report.updated}, ` +
                          `skipped ${report.skipped}, failed ${report.failed}`,
                      );
                      if (report.conflicts > 0) {
                        toast.warning(
                          `${report.conflicts} entr${
                            report.conflicts === 1 ? "y was" : "ies were"
                          } changed in Folio — resolve them below`,
                        );
                      }
                      for (const message of report.errors) toast.error(message);
                      void rows.refetch();
                    },
                    onError: (error) =>
                      toast.error(errorMessage(error, "Sync failed")),
                  })
                }
              >
                <RefreshCw
                  className={cn("size-4", sync.isPending && "animate-spin")}
                />
                Sync now
              </Button>
              <span className="text-xs text-muted-foreground">
                Last attempt {formatTimestamp(lastAttemptAt)}
              </span>
              {syncEnabled ? null : (
                <span className="text-xs text-muted-foreground">
                  Folio is connected but sync is off — nothing is pushed
                  until it is turned on in Access &amp; integrations.
                </span>
              )}
            </div>

            <dl className="flex flex-wrap gap-4 text-sm">
              {(["synced", "pending", "failed", "ignored"] as const).map(
                (state) => (
                  <div key={state} className="grid">
                    <dt className="text-xs text-muted-foreground">
                      {humanize(state)}
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {counts[state] ?? 0}
                    </dd>
                  </div>
                ),
              )}
            </dl>

            {rows.data?.imports && rows.data.imports.imported > 0 ? (
              <div className="grid gap-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-medium">Imported from Folio</h2>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/sales/expenses">
                      Categorize
                      <ArrowRight />
                    </Link>
                  </Button>
                </div>
                <dl className="flex flex-wrap gap-4">
                  {(
                    [
                      ["Imported", rows.data.imports.imported],
                      ["To categorize", rows.data.imports.toCategorize],
                      ["Changed or deleted in Folio", rows.data.imports.conflicts],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="grid">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                {rows.data.imports.conflicts > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Imported entries Folio changed after you categorized them,
                    or deleted, are resolved on the Expenses page.
                  </p>
                ) : null}
              </div>
            ) : null}

            {(rows.data?.retiredBooks ?? []).length > 0 ? (
              <div className="grid gap-1 text-sm">
                <h2 className="font-medium">Retired books</h2>
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {(rows.data?.retiredBooks ?? []).map((book) => (
                    <li key={book.bookId}>
                      {book.label}: {book.pushed} pushed and {book.imported}{" "}
                      imported entries stay linked to it. Atlas no longer
                      pushes to or pulls from it; editing one of them in Atlas
                      changes Atlas only.
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {conflicts.length > 0 ? (
              <div className="grid gap-2">
                <h2 className="flex items-center gap-1 text-sm font-medium">
                  <AlertTriangle className="size-4 shrink-0 text-destructive" />
                  Changed in Folio ({conflicts.length})
                </h2>
                <p className="text-xs text-muted-foreground">
                  Pushing the local version overwrites Folio; ignoring stops
                  syncing that entry and leaves Folio alone.
                </p>
                <ul className="grid gap-2">
                  {conflicts.map((row) => (
                    <ConflictRow
                      key={row.id}
                      row={row}
                      busy={busy}
                      canPush={syncEnabled}
                      onPush={(id) =>
                        push.mutate(id, {
                          onSuccess: () => {
                            toast.success("Pushed the beez version");
                            void rows.refetch();
                          },
                          onError: (error) =>
                            toast.error(errorMessage(error, "Push failed")),
                        })
                      }
                      onIgnore={(id) =>
                        ignore.mutate(id, {
                          onSuccess: () => {
                            toast.success("Stopped syncing that entry");
                            void rows.refetch();
                          },
                          onError: (error) =>
                            toast.error(
                              errorMessage(error, "Could not ignore"),
                            ),
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {failures.length > 0 ? (
              <div className="grid gap-2">
                <h2 className="text-sm font-medium">
                  Could not be pushed ({failures.length})
                </h2>
                <ul className="grid gap-2">
                  {failures.map((row) => (
                    <li key={row.id} className="rounded-md border p-3 text-sm">
                      <span className="font-medium">
                        {humanize(row.entityType)}
                        {row.summary ? ` — ${row.summary}` : ""}
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {row.lastError}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Credentials, the book and the account mapping are edited in
                Access &amp; integrations.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/admin#gnucash">
                  Folio settings
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        )}
    </>
  );
}

export function ReconciliationView() {
  return (
    <div className="grid gap-6">
      <PageHeader subtitle="Check what the feed pushed to Folio, what failed, and what changed in the book behind us." />
      {/* The reads are admin-only, so they are mounted behind the gate rather
          than beside it. */}
      <AdminReportGate>
        <ReconciliationReport />
      </AdminReportGate>
    </div>
  );
}
