"use client";

/**
 * Loss report: what was damaged, retired, or written off in a period, and what
 * it was worth. Every row comes from the same ledger the stock counts do, so
 * the totals and the event list cannot disagree.
 */

import * as React from "react";
import { TrendingDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { formatCents, formatDate } from "./format";
import { useLossReport } from "./hooks";
import { LOSS_KIND_LABELS, reasonLabel } from "./types";

/** The first of January this year, as a date-input value. */
function startOfYearISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function LossReportCard() {
  const [from, setFrom] = React.useState(startOfYearISO);
  const [to, setTo] = React.useState("");
  const report = useLossReport({ from, to });

  const totals = report.data?.totals;
  const hasLosses =
    totals != null &&
    totals.damaged + totals.retired + totals.writtenOff > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingDown className="size-4 text-primary" />
          Losses
        </CardTitle>
        <CardDescription>
          Equipment damaged, retired, or written off — and what it cost you.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="loss-from" className="text-xs">
              From
            </Label>
            <Input
              id="loss-from"
              type="date"
              className="h-8 w-40"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loss-to" className="text-xs">
              To
            </Label>
            <Input
              id="loss-to"
              type="date"
              className="h-8 w-40"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            All time
          </Button>
        </div>

        {report.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : report.isError ? (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p>Could not load the loss report.</p>
            <Button variant="outline" size="sm" onClick={() => report.refetch()}>
              Retry
            </Button>
          </div>
        ) : !hasLosses ? (
          <p className="py-3 text-sm text-muted-foreground">
            No equipment losses recorded in this period.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <LossStat label="Damaged" value={totals.damaged} />
              <LossStat label="Retired" value={totals.retired} />
              <LossStat label="Written off" value={totals.writtenOff} />
              <LossStat
                label="Value"
                value={formatCents(totals.valueCents)}
              />
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Equipment</TableHead>
                    <TableHead className="text-right">Damaged</TableHead>
                    <TableHead className="text-right">Retired</TableHead>
                    <TableHead className="text-right">Written off</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.byType.map((row) => (
                    <TableRow key={row.typeId}>
                      <TableCell className="font-medium">
                        {row.typeName}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.damaged || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.retired || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.writtenOff || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCents(row.valueCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {report.data.events.length > 0 && (
              <div className="grid gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent events
                </h3>
                <ul className="divide-y">
                  {report.data.events.slice(0, 12).map((event) => (
                    <li
                      key={event.id}
                      className="flex min-h-12 items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {event.quantity}× {event.typeName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatDate(event.date)} · {reasonLabel(event.reason)}
                          {event.notes ? ` · ${event.notes}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="secondary">
                          {LOSS_KIND_LABELS[event.kind] ?? event.kind}
                        </Badge>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatCents(event.valueCents)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LossStat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
