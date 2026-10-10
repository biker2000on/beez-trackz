"use client";

import * as React from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Download } from "lucide-react";
import { toast } from "sonner";

import { AccountSelector } from "@/components/ui/account-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  useGnuCashBooks,
  useRenameGnuCashBook,
  useRunFolioImport,
  useSwitchGnuCashBook,
  type FolioImportReport,
  type GnuCashAccount,
  type GnuCashAccountMapping,
  type GnuCashSettings,
  type GnuCashSettingsPayload,
} from "@/features/settings/api";
import {
  errorMessage,
  formatTimestamp,
} from "@/features/settings/gnucash-format";

function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The active Folio book connection, the "Switch to a new book" flow, and the
 * retired books (migration 00064).
 *
 * A switch retires the current connection and starts a new one: everything
 * already pushed to or imported from the old book stays linked to it and is
 * never pushed again; new entries go to the new book once it is tested,
 * mapped and enabled.
 */
export function FolioBookPanel({ data }: { data: GnuCashSettings }) {
  const books = useGnuCashBooks();
  const rename = useRenameGnuCashBook();
  const switchBook = useSwitchGnuCashBook();
  const [labelDraft, setLabelDraft] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const [draft, setDraft] = React.useState({
    label: "",
    baseUrl: "",
    apiToken: "",
    importStartDate: todayISO(),
  });

  const active = data.activeBook;
  const retired = (books.data?.books ?? []).filter((book) => book.retiredAt);
  const activeSummary = (books.data?.books ?? []).find((book) => book.active);

  function submitSwitch(event: React.FormEvent) {
    event.preventDefault();
    switchBook.mutate(
      {
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim() || data.baseUrl,
        apiToken: draft.apiToken.trim(),
        importStartDate: draft.importStartDate || undefined,
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.retiredBook
              ? `Retired ${result.retiredBook.label}; now connected to ${result.activeBook.label}. Test the connection next.`
              : `Connected ${result.activeBook.label}. Test the connection next.`,
          );
          setSwitching(false);
          setDraft({ label: "", baseUrl: "", apiToken: "", importStartDate: todayISO() });
          void books.refetch();
        },
        onError: (error) =>
          toast.error(errorMessage(error, "Could not switch books")),
      },
    );
  }

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            <BookOpen className="size-4 shrink-0" />
            Active book
          </p>
          {active ? (
            <div className="grid gap-1 text-xs text-muted-foreground">
              <Input
                aria-label="Book connection name"
                className="h-8 w-64 text-sm"
                value={labelDraft ?? active.label}
                onChange={(event) => setLabelDraft(event.target.value)}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  setLabelDraft(null);
                  if (!value || value === active.label) return;
                  rename.mutate(
                    { id: active.id, label: value },
                    {
                      onSuccess: () => toast.success("Book renamed"),
                      onError: (error) =>
                        toast.error(errorMessage(error, "Could not rename")),
                    },
                  );
                }}
              />
              <span>
                {active.baseUrl || data.baseUrl}
                {active.bookGuid
                  ? ` · ${active.bookName || "Folio book"} (${active.bookGuid})`
                  : " · not tested yet"}
              </span>
              <span>
                Connected {formatTimestamp(active.connectedAt)}
                {activeSummary
                  ? ` · ${activeSummary.pushed} pushed · ${activeSummary.imported} imported`
                  : ""}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Recorded the first time the connection test succeeds.
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={data.restorePending}
          title={
            data.restorePending
              ? "Finish or discard the restore before switching books"
              : undefined
          }
          onClick={() => setSwitching((value) => !value)}
        >
          Switch to a new book
        </Button>
      </div>

      {switching ? (
        <form className="grid gap-3 rounded-md bg-muted/40 p-3" onSubmit={submitSwitch}>
          <p className="flex items-start gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            The current book is retired, not deleted: every sale and expense
            already pushed to it, and everything imported from it, stays
            linked to it and is never pushed again. The new book starts with
            sync off and no account mapping; entries not pushed yet go to it.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="folio-switch-label">Name</Label>
              <Input
                id="folio-switch-label"
                required
                placeholder="Bee business book"
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="folio-switch-url">Folio base URL</Label>
              <Input
                id="folio-switch-url"
                type="url"
                placeholder={data.baseUrl || "https://folio.example.com"}
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="folio-switch-token">New book&apos;s access token</Label>
              <Input
                id="folio-switch-token"
                type="password"
                autoComplete="off"
                required
                placeholder="gcw_… bound to the new book"
                value={draft.apiToken}
                onChange={(event) => setDraft({ ...draft, apiToken: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="folio-switch-start">Import history from</Label>
              <Input
                id="folio-switch-start"
                type="date"
                value={draft.importStartDate}
                onChange={(event) =>
                  setDraft({ ...draft, importStartDate: event.target.value })
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                switchBook.isPending || !draft.label.trim() || !draft.apiToken.trim()
              }
            >
              Retire the current book and connect
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSwitching(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {retired.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-xs font-medium">Retired books</p>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {retired.map((book) => (
              <li key={book.id}>
                {book.label}
                {book.bookName ? ` (${book.bookName})` : ""} · retired{" "}
                {formatTimestamp(book.retiredAt)} · {book.pushed} pushed ·{" "}
                {book.imported} imported — read-only history, never pushed to
                or pulled from again
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Use one account for every category": the user keeps all beekeeping
 * income and expenses under one Folio account, so every sale-line kind and
 * expense category maps there in one step.
 */
export function OneAccountShortcut({
  data,
  mapping,
  accounts,
  disabled,
  onApply,
}: {
  data: GnuCashSettings;
  mapping: GnuCashAccountMapping;
  accounts: GnuCashAccount[];
  disabled: boolean;
  onApply: (next: GnuCashAccountMapping) => void;
}) {
  const [guid, setGuid] = React.useState("");
  if (accounts.length === 0) return null;
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Label htmlFor="gnucash-one-account">
        Use one account for all income and expense categories
        <span className="ml-1 font-normal text-muted-foreground">
          Sets every sale kind and expense category below to the same account.
        </span>
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-64 flex-1">
          <AccountSelector
            id="gnucash-one-account"
            value={guid}
            accounts={accounts}
            onChange={setGuid}
            clearLabel="Choose an account"
            missingLabel={(value) => value}
            placeholder="Choose an account"
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={disabled || guid === ""}
          onClick={() => {
            const revenue: Record<string, string> = {};
            for (const kind of data.saleLineKinds) revenue[kind] = guid;
            const expenses: Record<string, string> = {};
            for (const category of data.expenseCategories) expenses[category] = guid;
            onApply({ ...mapping, revenue, expenses });
          }}
        >
          Apply to every category
        </Button>
      </div>
    </div>
  );
}

/**
 * The Folio history import: which accounts to read, from which date, and the
 * "Import now" action. Imported expenses and income land on the Expenses page
 * under "To categorize".
 */
export function FolioImportPanel({
  data,
  accounts,
  busy,
  save,
}: {
  data: GnuCashSettings;
  accounts: GnuCashAccount[];
  busy: boolean;
  save: (payload: GnuCashSettingsPayload, done?: string) => void;
}) {
  const run = useRunFolioImport();
  const [report, setReport] = React.useState<FolioImportReport | null>(null);
  const [startDraft, setStartDraft] = React.useState<string | null>(null);
  const usingDefault = data.importAccountGuids.length === 0;
  const selected = new Set(data.effectiveImportAccountGuids);
  const byGuid = new Map(accounts.map((account) => [account.guid, account]));
  const postable = accounts.filter((account) => !account.placeholder);

  function toggle(guid: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(guid);
    else next.delete(guid);
    save({ importAccountGuids: [...next] }, "Import accounts saved");
  }

  function start(full: boolean) {
    run.mutate(full, {
      onSuccess: (result) => {
        setReport(result);
        for (const message of result.errors) toast.error(message);
        toast.success(
          `Imported ${result.importedExpenses} expense${result.importedExpenses === 1 ? "" : "s"} and ${result.importedIncome} income entr${result.importedIncome === 1 ? "y" : "ies"}`,
        );
      },
      onError: (error) => toast.error(errorMessage(error, "Import failed")),
    });
  }

  return (
    <div className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">Import history from Folio</h3>
        <p className="text-xs text-muted-foreground">
          Folio transactions on the import accounts that Atlas did not push
          become Atlas expenses (money out) or other income (money in), to be
          categorized on the Expenses page. Nothing is written back to Folio,
          and no sale or stock movement is ever created from Folio data.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 sm:items-center">
        <Label htmlFor="folio-import-start">
          Import history from
          <span className="ml-1 font-normal text-muted-foreground">
            Moving it earlier imports the newly included history once.
          </span>
        </Label>
        <Input
          id="folio-import-start"
          type="date"
          value={startDraft ?? data.importStartDate ?? ""}
          onChange={(event) => setStartDraft(event.target.value)}
          onBlur={(event) => {
            const value = event.target.value;
            setStartDraft(null);
            if (value === (data.importStartDate ?? "")) return;
            save({ importStartDate: value }, "Import start date saved");
          }}
        />
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-medium">
          Import accounts
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {usingDefault
              ? "Using the accounts the category mapping points at."
              : "Chosen by hand."}
          </span>
        </p>
        {postable.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {data.effectiveImportAccountGuids.length > 0
              ? `${data.effectiveImportAccountGuids.length} account(s). Load accounts above to change them.`
              : "None yet. Load accounts above, then pick the account your beekeeping lives in."}
          </p>
        ) : (
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
            {postable.map((account) => (
              <label key={account.guid} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(account.guid)}
                  disabled={busy}
                  onChange={(event) => toggle(account.guid, event.target.checked)}
                />
                <span>{account.fullName}</span>
                <span className="text-xs text-muted-foreground">{account.type}</span>
              </label>
            ))}
          </div>
        )}
        {!usingDefault ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => save({ importAccountGuids: [] }, "Using the mapping's accounts")}
            >
              Use the mapping&apos;s accounts instead
            </Button>
          </div>
        ) : null}
        {[...selected].some((guid) => accounts.length > 0 && !byGuid.has(guid)) ? (
          <p className="text-xs text-warning">
            An import account no longer exists in Folio.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={run.isPending || !data.importStartDate || !data.activeBook}
          onClick={() => start(false)}
        >
          <Download />
          Import now
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={run.isPending || !data.importStartDate || !data.activeBook}
          title="Reads the whole book again; also detects transactions deleted in Folio"
          onClick={() => start(true)}
        >
          Full rescan
        </Button>
        <span className="text-xs text-muted-foreground">
          Last import {formatTimestamp(data.lastImportAt)}
        </span>
      </div>

      {report ? (
        <div className="grid gap-1 rounded-md border p-3 text-xs">
          <p className="flex items-center gap-1 text-sm font-medium">
            <CheckCircle2 className="size-4 shrink-0 text-success" />
            {report.full ? "Full scan" : "Import"}
            {report.scanComplete ? " finished" : " stopped early"}
          </p>
          <p>
            {report.importedExpenses} expenses and {report.importedIncome} income
            entries imported · {report.updated} updated · {report.conflicts}{" "}
            conflicts · {report.deleted} deleted in Folio
          </p>
          <p className="text-muted-foreground">
            Read {report.pulled} changes. Skipped {report.skippedPushedByAtlas} pushed by
            Atlas, {report.skippedBeforeStart} before the start date,{" "}
            {report.skippedTransfers} transfers, {report.skippedUnrepresentable}{" "}
            unrepresentable; {report.outOfScope} did not touch an import account.
          </p>
        </div>
      ) : null}
    </div>
  );
}
