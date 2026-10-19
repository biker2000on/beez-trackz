"use client";

/**
 * Jar serials on a sale's receipt — the write end of serialized traceability.
 *
 * Admin-only, and hidden from print: a customer receipt has no business
 * carrying the operator's linking controls, but the beekeeper reconciling an
 * order needs them on the same screen as the line items.
 *
 * The backend rejects a batch wholesale and names the offending serial, so
 * pasting a scanner dump of a dozen codes either records all of them or tells
 * you exactly which one is wrong — no guessing at a half-applied batch.
 */

import * as React from "react";
import Link from "next/link";
import { Loader2, Plus, X } from "lucide-react";

import { createColumnHelper, useTable } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  gridMeta,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";

import { useLinkSaleSerials, useSaleSerials, useUnlinkSaleSerial } from "./api";

/** Split on commas, whitespace, or newlines so a scanner dump pastes cleanly. */
function parseSerials(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function SaleSerials({ saleId }: { saleId: string }) {
  const access = useAccessProfile();
  const serials = useSaleSerials(saleId);
  const link = useLinkSaleSerials(saleId);
  const unlink = useUnlinkSaleSerial(saleId);
  const [draft, setDraft] = React.useState("");

  // The endpoints require admin; showing the controls to anyone else would
  // only promise an action the server will refuse.
  if (!access.data?.isAdmin) return null;

  const parsed = parseSerials(draft);

  function add(event: React.FormEvent) {
    event.preventDefault();
    if (parsed.length === 0) return;
    link.mutate(parsed, { onSuccess: () => setDraft("") });
  }

  return (
    <Card className="print:hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Jar serials</CardTitle>
        <p className="text-sm text-muted-foreground">
          Which serialized jars went out on this order.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {serials.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : serials.isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load the jar serials for this sale.
          </p>
        ) : serials.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No jars linked yet.
          </p>
        ) : (
          <SerialGrid
            serials={serials.data}
            unlinking={unlink.isPending}
            onUnlink={(serial) => unlink.mutate(serial)}
          />
        )}

        <ShortcutForm onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="link-serials">Add serials</Label>
            <Input
              id="link-serials"
              value={draft}
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="One or more, separated by commas or spaces"
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={parsed.length === 0 || link.isPending}>
            {link.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Link {parsed.length > 1 ? `${parsed.length} jars` : "jar"}
          </Button>
        </ShortcutForm>
      </CardContent>
    </Card>
  );
}
type SaleSerial = NonNullable<ReturnType<typeof useSaleSerials>["data"]>[number];
const serialHelper = createColumnHelper<typeof dataGridFeatures, SaleSerial>();

/** What the unlink cell reads from `table.options.meta`. */
interface SerialMeta {
  unlinking: boolean;
  onUnlink: (serial: string) => void;
}

function SerialGrid({
  serials,
  unlinking,
  onUnlink,
}: {
  serials: SaleSerial[];
  unlinking: boolean;
  onUnlink: (serial: string) => void;
}) {
  const columns = React.useMemo(
    () =>
      serialHelper.columns([
        serialHelper.accessor((item) => item.serialNumber, {
          id: "serial",
          header: "Serial",
          cell: ({ getValue }) => (
            <DataGridCellAction className="inline">
              <Link
                href={`/production/serials?serial=${encodeURIComponent(getValue())}`}
                className="break-all font-mono text-sm underline-offset-4 hover:underline"
              >
                {getValue()}
              </Link>
            </DataGridCellAction>
          ),
        }),
        serialHelper.accessor((item) => item.lotCode ?? "", {
          id: "lot",
          header: "Lot",
          meta: { filter: true, filterAllLabel: "All lots" } satisfies DataGridColumnMeta,
        }),
        serialHelper.accessor((item) => item.jarSizeLabel ?? "", {
          id: "size",
          header: "Jar size",
          meta: { filter: true, filterAllLabel: "All sizes" } satisfies DataGridColumnMeta,
        }),
        serialHelper.display({
          id: "actions",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: item }, table }) => {
            const { unlinking, onUnlink } = gridMeta<SerialMeta>(table);
            return (
            <DataGridCellAction>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Unlink ${item.serialNumber}`}
                disabled={unlinking}
                onClick={() => onUnlink(item.serialNumber)}
              >
                <X />
              </Button>
            </DataGridCellAction>
            );
          },
        }),
      ]),
    [],
  );
  // The pending flag and the (inline) callback reach the cell through `meta`
  // so a click never rebuilds a column and unmounts the focused button.
  const serialMeta: SerialMeta = { unlinking, onUnlink };
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: serials,
    getRowId: (item) => item.serialNumber,
    meta: serialMeta,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Jar serials"
        listenOnWindow={false}
        searchable={serials.length > 8}
      />
    </div>
  );
}
