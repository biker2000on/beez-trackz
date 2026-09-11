"use client";
import { useState } from "react";
import Link from "next/link";
import { useHarvestLots } from "./api";
import { BottlingDialog } from "./lots-tab";
import { Button } from "@/components/ui/button";
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
      <Link href="/production/lots" className="text-sm underline">
        All lots
      </Link>
      <header className="atlas-heading">
        <div>
          <p className="atlas-eyebrow">Production / Lot record</p>
          <h1>{lot.lotCode}</h1>
          <p className="mt-2 text-muted-foreground">
            {lot.varietalName ?? "Varietal not recorded"} / Extracted{" "}
            {formatDate(lot.extractionDate)}
          </p>
        </div>
        <Button onClick={() => setBottle(true)}>Bottle this lot</Button>
      </header>
      {lot.lockout?.locked && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {lot.lockout.message}
        </p>
      )}
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
            href={`/stock/bulk?harvestLotId=${id}`}
            className="mt-3 inline-flex text-sm underline"
          >
            Current stock by location
          </Link>
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Bottling history</h2>
        <div className="atlas-records">
          {lot.bottlingRuns.length ? (
            lot.bottlingRuns.map((run) => (
              <article
                key={run.id}
                className="atlas-record flex flex-wrap justify-between gap-3"
              >
                <div>
                  <p className="font-medium">
                    {run.quantity} {run.jarSizeLabel ?? "jars"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(run.bottledDate)} /{" "}
                    {run.honeyLbs == null
                      ? "Honey draw not recorded"
                      : formatLbs(run.honeyLbs)}
                  </p>
                </div>
                <Link
                  href={`/production/lots/${id}/runs/${run.id}`}
                  className="text-sm underline"
                >
                  Full run record
                </Link>
              </article>
            ))
          ) : (
            <p className="atlas-record text-sm text-muted-foreground">
              No bottling runs recorded.
            </p>
          )}
        </div>
      </section>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href={`/api/v1/harvest-lots/${id}/qr`}>Lot QR label</Link>
        </Button>
        {lot.isPublic && (
          <Button asChild variant="outline">
            <Link href={`/honey/${lot.publicSlug}`}>Honey story</Link>
          </Button>
        )}
      </div>
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
      <Link className="underline" href={`/production/lots/${lotId}`}>
        Source lot {lot?.lotCode}
      </Link>
      <header className="atlas-heading">
        <div>
          <p className="atlas-eyebrow">Production / Bottling run</p>
          <h1>
            {run.quantity} {run.jarSizeLabel ?? "jars"}
          </h1>
          <p>{formatDate(run.bottledDate)}</p>
        </div>
      </header>
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
        href={`/stock/finished?harvestLotId=${lotId}`}
      >
        Find finished stock
      </Link>
    </div>
  );
}
