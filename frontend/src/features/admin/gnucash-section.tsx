"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import {
  useAcknowledgeGnuCashRestore,
  useGnuCashAccounts,
  useGnuCashSettings,
  useTestGnuCashConnection,
  useUpdateGnuCashSettings,
  type GnuCashAccount,
  type GnuCashAccountMapping,
  type GnuCashSettings,
  type GnuCashSettingsPayload,
} from "@/features/settings/api";
import {
  errorMessage,
  humanize,
} from "@/features/settings/gnucash-format";

/** Sentinel for "not mapped" in the account selects. */
const UNMAPPED = "__unmapped__";

/** Human labels for the slots that are not a sale kind or expense category. */
const LEDGER_SLOTS: { key: LedgerSlot; label: string; hint: string }[] = [
  { key: "cash", label: "Cash / bank", hint: "Required. Funds every entry." },
  {
    key: "accountsReceivable",
    label: "Accounts receivable",
    hint: "Where the unpaid balance of a sale lands.",
  },
  {
    key: "salesTax",
    label: "Sales tax liability",
    hint: "Required only once a sale records tax.",
  },
  {
    key: "discount",
    label: "Sales discounts",
    hint: "Required only once a sale records a discount.",
  },
  {
    key: "cogs",
    label: "Cost of goods sold",
    hint: "Optional pair with inventory. Map both or neither.",
  },
  {
    key: "inventory",
    label: "Inventory",
    hint: "Credited for the frozen cost basis of what was sold.",
  },
];

type LedgerSlot =
  | "cash"
  | "accountsReceivable"
  | "salesTax"
  | "discount"
  | "cogs"
  | "inventory";

/**
 * One account picker. Until the account list has been loaded from GnuCash the
 * control falls back to showing the stored GUID, so an existing mapping is
 * never silently blanked by a page that could not reach folio.
 */
function AccountSelect({
  id,
  value,
  accounts,
  onChange,
}: {
  id: string;
  value: string;
  accounts: GnuCashAccount[];
  onChange: (guid: string) => void;
}) {
  if (accounts.length === 0) {
    return (
      <p className="truncate text-xs text-muted-foreground" id={id}>
        {value ? `Mapped: ${value}` : "Not mapped"}
      </p>
    );
  }
  // The stored GUID may name an account that has since been deleted in
  // GnuCash; keep it selectable so the operator sees what is there.
  const known = accounts.some((account) => account.guid === value);
  return (
    <select
      id={id}
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
      value={value === "" ? UNMAPPED : value}
      onChange={(event) =>
        onChange(event.target.value === UNMAPPED ? "" : event.target.value)
      }
    >
      <option value={UNMAPPED}>Not mapped</option>
      {!known && value !== "" ? (
        <option value={value}>{value} (missing in GnuCash)</option>
      ) : null}
      {accounts.map((account) => (
        <option key={account.guid} value={account.guid}>
          {account.fullName}
        </option>
      ))}
    </select>
  );
}

/**
 * The GnuCash *configuration*: folio credentials, the book identity and
 * cursor, the account mapping and the restore acknowledgement (design
 * 2026-09-03 §6.3, S6). Its output — the reconciliation report — is at
 * `/insights/reconciliation`.
 */
export function GnuCashSection() {
  const settings = useGnuCashSettings();
  const update = useUpdateGnuCashSettings();
  const test = useTestGnuCashConnection();

  // The stored token is never returned; this is only the draft replacement.
  const [tokenDraft, setTokenDraft] = React.useState("");
  const [baseUrlDraft, setBaseUrlDraft] = React.useState<string | null>(null);
  const [loadAccounts, setLoadAccounts] = React.useState(false);
  const accounts = useGnuCashAccounts(loadAccounts);
  const acknowledge = useAcknowledgeGnuCashRestore();

  if (settings.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load GnuCash sync settings.
      </p>
    );
  }
  if (settings.isLoading || !settings.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const data: GnuCashSettings = settings.data;
  // restore_state (00049) is the durable window, not a guess from "cursor
  // present and sync off": pausing a healthy integration is not a restore.
  const restorePending = data.restorePending;
  const reconciled = data.restoreState === "reconciled";
  const mapping = data.accountMapping ?? {};
  const accountList = accounts.data?.accounts ?? [];
  const busy = update.isPending;

  function save(payload: GnuCashSettingsPayload, done?: string) {
    update.mutate(payload, {
      onSuccess: () => {
        if (done) toast.success(done);
      },
      onError: (error) =>
        toast.error(errorMessage(error, "Could not save GnuCash settings")),
    });
  }

  function saveMapping(next: GnuCashAccountMapping) {
    save({ accountMapping: next });
  }

  function setRevenue(kind: string, guid: string) {
    const revenue = { ...(mapping.revenue ?? {}) };
    if (guid === "") delete revenue[kind];
    else revenue[kind] = guid;
    saveMapping({ ...mapping, revenue });
  }

  function setExpense(category: string, guid: string) {
    const expenses = { ...(mapping.expenses ?? {}) };
    if (guid === "") delete expenses[category];
    else expenses[category] = guid;
    saveMapping({ ...mapping, expenses });
  }

  function setSlot(slot: LedgerSlot, guid: string) {
    saveMapping({ ...mapping, [slot]: guid });
  }

  return (
    <div className="grid gap-5" data-config-editor="gnucash">
      <p className="text-sm text-muted-foreground">
        Push sales and expenses into a GnuCash book through folio, as balanced
        double-entry transactions. Beez stays authoritative for physical
        quantities — jars, colonies, and equipment. Nothing read back from
        GnuCash ever changes a beez record; a book edited behind us shows up
        as a conflict on the reconciliation report for you to resolve.
      </p>

      {/* --- connection --- */}
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="gnucash-base-url">folio base URL</Label>
          <Input
            id="gnucash-base-url"
            type="url"
            placeholder="https://folio.example.com"
            value={baseUrlDraft ?? data.baseUrl}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
            onBlur={(event) => {
              const value = event.target.value.trim();
              setBaseUrlDraft(null);
              if (value === data.baseUrl) return;
              save({ baseUrl: value }, "GnuCash server saved");
            }}
          />
          <p className="text-xs text-muted-foreground">
            The host only. Changing it clears the cached book and the change
            cursor, because both belong to the old book.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="gnucash-token">Personal access token</Label>
          <div className="flex gap-2">
            <Input
              id="gnucash-token"
              type="password"
              autoComplete="off"
              placeholder={
                data.hasToken
                  ? "Token saved — type to replace"
                  : "gcw_… from folio"
              }
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              onBlur={() => {
                const value = tokenDraft.trim();
                if (value === "") return;
                setTokenDraft("");
                save({ apiToken: value }, "GnuCash token saved");
              }}
            />
            {data.hasToken ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setTokenDraft("");
                  save({ apiToken: "" }, "GnuCash token cleared");
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Bound to one folio book. It is sent only from this server and is
            never shown again.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.error) toast.error(result.error);
                  else
                    toast.success(
                      `Connected to ${result.bookName ?? "the book"} (${
                        result.rootCurrency ?? "?"
                      })`,
                    );
                },
                onError: (error) =>
                  toast.error(errorMessage(error, "Connection test failed")),
              })
            }
          >
            Test connection
          </Button>
          {data.bookName ? (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="size-3.5 shrink-0" />
              {data.bookName} · {data.rootCurrency}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Not connected yet
            </span>
          )}
        </div>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={data.syncEnabled}
            disabled={busy || restorePending}
            onChange={(event) => save({ syncEnabled: event.target.checked })}
          />
          <span>
            Sync enabled. Runs are still started by hand below; this flag marks
            the integration as live. While it is off the server refuses every
            push, not just the button.
            {restorePending ? (
              <span className="block text-xs text-muted-foreground">
                Locked until the restored sync state below is reconciled. The
                server refuses to enable it, so this is not only a disabled
                checkbox.
              </span>
            ) : null}
          </span>
        </label>

        {restorePending ? (
          <div className="grid gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
            <p className="flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              Restored sync state, reconciliation pending
            </p>
            <p className="text-xs text-muted-foreground">
              A snapshot restore installed this book identity, the change
              cursor, and the per-entry sync state after proving these
              credentials open the same book. Nothing is pushed until you run
              the pull-first reconciliation and the no-write push dry run, then
              enable sync. Changing the server or token is refused while this
              is pending, so re-entering the token cannot wipe the restore.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || acknowledge.isPending}
                onClick={() =>
                  acknowledge.mutate(undefined, {
                    onSuccess: () =>
                      toast.success(
                        "Reconciliation acknowledged. You can enable sync when you are ready.",
                      ),
                    onError: (error) =>
                      toast.error(
                        errorMessage(
                          error,
                          "Could not acknowledge the reconciliation",
                        ),
                      ),
                  })
                }
              >
                I have reconciled this restore
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || acknowledge.isPending}
                onClick={() =>
                  save(
                    { discardRestore: true },
                    "Discarded the restored book and cursor",
                  )
                }
              >
                Discard restored sync state
              </Button>
            </div>
          </div>
        ) : null}

        {reconciled ? (
          <div className="grid gap-1 rounded-md border p-3">
            <p className="flex items-center gap-1 text-sm font-medium">
              <CheckCircle2 className="size-4 shrink-0 text-success" />
              Restore reconciled
            </p>
            <p className="text-xs text-muted-foreground">
              The reconciliation is signed off. Enable sync above when you are
              ready for beez to push into this book again.
            </p>
          </div>
        ) : null}
      </div>

      <Separator />

      {/* --- account mapping --- */}
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Account mapping</h3>
            <p className="text-xs text-muted-foreground">
              An unmapped kind or category fails its row with a message naming
              what is missing — it is never posted to a guessed account.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={accounts.isFetching}
            onClick={() => {
              setLoadAccounts(true);
              void accounts.refetch();
            }}
          >
            {accountList.length > 0 ? "Reload accounts" : "Load accounts"}
          </Button>
        </div>
        {accounts.isError ? (
          <p className="text-xs text-destructive">
            {errorMessage(accounts.error, "Could not load accounts")}
          </p>
        ) : null}

        <div className="grid gap-3">
          {LEDGER_SLOTS.map((slot) => (
            <div key={slot.key} className="grid gap-1 sm:grid-cols-2 sm:items-center">
              <Label htmlFor={`gnucash-slot-${slot.key}`}>
                {slot.label}
                <span className="ml-1 font-normal text-muted-foreground">
                  {slot.hint}
                </span>
              </Label>
              <AccountSelect
                id={`gnucash-slot-${slot.key}`}
                value={mapping[slot.key] ?? ""}
                accounts={accountList}
                onChange={(guid) => setSlot(slot.key, guid)}
              />
            </div>
          ))}
        </div>

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Revenue by sale line</h4>
          {data.saleLineKinds.map((kind) => (
            <div key={kind} className="grid gap-1 sm:grid-cols-2 sm:items-center">
              <Label htmlFor={`gnucash-revenue-${kind}`}>{humanize(kind)}</Label>
              <AccountSelect
                id={`gnucash-revenue-${kind}`}
                value={mapping.revenue?.[kind] ?? ""}
                accounts={accountList}
                onChange={(guid) => setRevenue(kind, guid)}
              />
            </div>
          ))}
        </div>

        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Expenses by category</h4>
          {data.expenseCategories.map((category) => (
            <div
              key={category}
              className="grid gap-1 sm:grid-cols-2 sm:items-center"
            >
              <Label htmlFor={`gnucash-expense-${category}`}>
                {humanize(category)}
              </Label>
              <AccountSelect
                id={`gnucash-expense-${category}`}
                value={mapping.expenses?.[category] ?? ""}
                accounts={accountList}
                onChange={(guid) => setExpense(category, guid)}
              />
            </div>
          ))}
        </div>
      </div>

      <Separator />

      {/* The output of this configuration is a report, and reports live in
          Insights (design 2026-09-03 §6.3, S6). Sync runs, the push counts and
          the conflict queue are all there; this section owns the credentials,
          the book and the mapping, and nothing else. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Runs, push counts and entries changed in GnuCash are reported under
          Insights.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/insights/reconciliation">
            Reconciliation report
            <ArrowRight />
          </Link>
        </Button>
      </div>
    </div>
  );
}
