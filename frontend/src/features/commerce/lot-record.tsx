"use client";
import { useState } from "react";
import Link from "next/link";
import { useHarvestLots } from "./api";
import { BottlingDialog } from "./lots-tab";
import { BottlingRunsGrid } from "./bottling-runs-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RecordHeader } from "@/components/record/record-header";
import { formatDate, formatLbs } from "@/features/honey/format";
export function LotRecord({ id }: { id: string }) {
  const lots = useHarvestLots();
  const [bottle, setBottle] = useState(false);
  const lot = lots.data?.find((l) => l.id === id);
  if (lots.isPending) return <p>Loading lot...</p>;
  if (lots.isError)
    return (
      <p>
        Could not load this lot.{" "}
        <button onClick={() => lots.refetch()}>Retry</button>
      </p>
    );
  if (!lot)
    return (
      <p>
        Lot not found. <Link href="/production/lots">Open lots</Link>
      </p>
    );
  return (
    <div className="atlas-workspace">
      <RecordHeader
        name={lot.lotCode}
        collectionHref="/production/lots"
        status={
          lot.isPublic ? <Badge variant="secondary">Public story</Badge> : undefined
        }
        context={[
          lot.varietalName ?? "Varietal not recorded",
          `Extracted ${formatDate(lot.extractionDate)}`,
          `${formatLbs(lot.honeyWeightLbs)} extracted`,
        ]}
        primary={<Button onClick={() => setBottle(true)}>Bottle this lot</Button>}
        secondary={
          <Button asChild variant="outline" size="sm">
            <Link href={`/api/v1/harvest-lots/${id}/qr`}>Lot QR label</Link>
          </Button>
        }
        more={
          lot.isPublic ? (
            <DropdownMenuItem asChild>
              <Link href={`/honey/${lot.publicSlug}`}>Honey story</Link>
            </DropdownMenuItem>
          ) : undefined
        }
      >
        {lot.lockout?.locked && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {lot.lockout.message}
          </p>
        )}
      </RecordHeader>
      <section className="atlas-records">
        <div className="atlas-record">
          <h2 className="font-semibold">Source and ancestry</h2>
          <p className="mt-2">
            {formatLbs(lot.honeyWeightLbs)} extracted / {lot.linkedHarvestCount}{" "}
            linked harvests
          </p>
          <p className="text-sm text-muted-foreground">
            {lot.sourceApiaries.length
              ? lot.sourceApiaries.join(", ")
              : "Origin not recorded"}
          </p>
          {lot.bloomNotes && <p className="mt-2 text-sm">{lot.bloomNotes}</p>}
          <Link
            href={`/stock?tab=bulk&harvestLotId=${id}`}
            className="mt-3 inline-flex text-sm underline"
          >
            Current stock by location
          </Link>
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Bottling history</h2>
        <div className="overflow-hidden rounded-xl border bg-card">
          <BottlingRunsGrid lotId={id} runs={lot.bottlingRuns} />
        </div>
      </section>
      {bottle && <BottlingDialog lot={lot} open onOpenChange={setBottle} />}
    </div>
  );
}
export function BottlingRunRecord({
  lotId,
  runId,
}: {
  lotId: string;
  runId: string;
}) {
  const lots = useHarvestLots();
  const lot = lots.data?.find((l) => l.id === lotId);
  const run = lot?.bottlingRuns.find((r) => r.id === runId);
  if (lots.isPending) return <p>Loading bottling run...</p>;
  if (!run)
    return (
      <p>
        Run unavailable.{" "}
        <Link href={`/production/lots/${lotId}`}>Source lot</Link>
      </p>
    );
  return (
    <div className="atlas-workspace">
      <RecordHeader
        name={`${run.quantity} ${run.jarSizeLabel ?? "jars"}`}
        collectionHref="/production/lots"
        context={[
          <Link
            key="lot"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            href={`/production/lots/${lotId}`}
          >
            Lot {lot?.lotCode}
          </Link>,
          `Bottled ${formatDate(run.bottledDate)}`,
        ]}
      />
      <section className="atlas-records">
        <div className="atlas-record">
          <h2 className="font-semibold">Saved output</h2>
          <p>
            {run.honeyLbs == null
              ? "Honey quantity not recorded"
              : formatLbs(run.honeyLbs)}{" "}
            consumed
          </p>
          <p>{run.serialCount} traceable serials</p>
          <p>{run.notes}</p>
        </div>
      </section>
      <Link
        className="underline"
        href={`/stock?tab=finished&harvestLotId=${lotId}`}
      >
        Find finished stock
      </Link>
    </div>
  );
}
