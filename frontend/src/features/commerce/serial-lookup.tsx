"use client";

/**
 * Serial lookup — type the code off a jar lid, get the jar's whole life.
 *
 * The chain reads top to bottom the way it happened: the jar was filled in a
 * bottling run, from a harvest lot, and then (maybe) sold. "Maybe" is the point
 * of the last card: an unsold jar and a jar on a cancelled order are different
 * situations, and both are normal, so neither is rendered as an error.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Package, Search, Store, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/features/honey/format";
import { ApiError } from "@/lib/api";

import { useJarSerialLookup, type JarSerialTrace } from "./api";

export function SerialLookup({ initialSerial = "" }: { initialSerial?: string }) {
  // `draft` is what the operator is typing; `serial` is what has been
  // submitted. Keeping them apart means no request fires per keystroke.
  const [draft, setDraft] = React.useState(initialSerial);
  const [serial, setSerial] = React.useState(initialSerial);
  const trace = useJarSerialLookup(serial);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSerial(draft.trim());
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="jar-serial">Jar serial</Label>
              <Input
                id="jar-serial"
                value={draft}
                autoFocus
                spellCheck={false}
                autoCapitalize="characters"
                placeholder="e.g. WF-2026-07-20260705-A1B2C3-0001"
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={draft.trim().length === 0}>
              <Search /> Look up
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            Printed on the jar label. Capitalisation does not matter.
          </p>
        </CardContent>
      </Card>

      {serial.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Enter a serial to trace a jar back to its bottling run, harvest lot,
            and the order it left on.
          </CardContent>
        </Card>
      ) : trace.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : trace.isError ? (
        <NotFoundCard serial={serial} error={trace.error} />
      ) : (
        <TraceChain trace={trace.data} />
      )}
    </div>
  );
}

function NotFoundCard({ serial, error }: { serial: string; error: unknown }) {
  const unknown = error instanceof ApiError && error.status === 404;
  return (
    <Card>
      <CardContent className="grid gap-2 py-10 text-center">
        <p className="text-sm font-medium">
          {unknown ? (
            <>No jar carries the serial &ldquo;{serial}&rdquo;</>
          ) : (
            <>Could not look up that serial</>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {unknown
            ? "Check for a mistyped character. Serials are only minted when a bottling run is serialized."
            : error instanceof Error
              ? error.message
              : "Please try again."}
        </p>
      </CardContent>
    </Card>
  );
}

function TraceChain({ trace }: { trace: JarSerialTrace }) {
  const { bottlingRun, harvestLot, sale } = trace;
  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader className="pb-3">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">Jar</p>
          <CardTitle className="break-all font-mono text-lg">{trace.serialNumber}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Serialized {formatDate(trace.createdAt)}
        </CardContent>
      </Card>

      <ChainStep
        icon={<Package className="size-4" aria-hidden />}
        label="Bottling run"
        title={
          bottlingRun.jarSizeLabel
            ? `${bottlingRun.jarSizeLabel} · ${bottlingRun.quantity} jars`
            : `${bottlingRun.quantity} jars`
        }
        detail={`Bottled ${formatDate(bottlingRun.bottledDate)}`}
      />

      <ChainStep
        icon={<Tag className="size-4" aria-hidden />}
        label="Harvest lot"
        title={harvestLot.lotCode}
        detail={
          [harvestLot.variety, harvestLot.season].filter(Boolean).join(" · ") ||
          "No variety recorded"
        }
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/harvest/lots">
              Lots &amp; QR <ArrowRight />
            </Link>
          </Button>
        }
      />

      {sale ? (
        <ChainStep
          icon={<Store className="size-4" aria-hidden />}
          label="Sale"
          title={sale.customerName ?? "Walk-up customer"}
          detail={
            <span className="flex flex-wrap items-center gap-2">
              <span>Sold {formatDate(sale.soldAt ?? sale.date)}</span>
              <Badge variant={sale.orderStatus === "cancelled" ? "destructive" : "secondary"}>
                {sale.orderStatus === "cancelled"
                  ? "Sale cancelled"
                  : sale.orderStatus.replaceAll("_", " ")}
              </Badge>
              {sale.linkedByName && (
                <span className="text-xs">linked by {sale.linkedByName}</span>
              )}
            </span>
          }
          action={
            <Button asChild size="sm" variant="outline">
              <Link href={`/harvest/sales/${sale.id}`}>
                Receipt <ArrowRight />
              </Link>
            </Button>
          }
        />
      ) : (
        <ChainStep
          icon={<Store className="size-4" aria-hidden />}
          label="Sale"
          title="Not sold yet"
          detail="This jar is still in inventory. Link it from a sale's receipt when it goes out."
        />
      )}
    </div>
  );
}

function ChainStep({
  icon,
  label,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 text-muted-foreground">{icon}</span>
          <div className="min-w-0">
            <p className="text-xs uppercase text-muted-foreground">{label}</p>
            <p className="font-medium">{title}</p>
            <div className="text-sm text-muted-foreground">{detail}</div>
          </div>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}
