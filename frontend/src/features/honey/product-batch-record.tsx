"use client";
import Link from "next/link";
import { useProductBatches } from "./hooks";
import { formatDate, formatLbs, formatMoney } from "./format";
export function ProductBatchRecord({ id }: { id: string }) {
  const batches = useProductBatches();
  const batch = batches.data?.find((b) => b.id === id);
  if (batches.isPending) return <p>Loading batch...</p>;
  if (batches.isError)
    return (
      <p>
        Could not load this batch.{" "}
        <button className="underline" onClick={() => batches.refetch()}>
          Retry
        </button>
      </p>
    );
  if (!batch)
    return (
      <p>
        Batch not found.{" "}
        <Link href="/production/products">Open hive products</Link>
      </p>
    );
  return (
    <div className="atlas-workspace">
      <Link className="text-sm underline" href="/production/products">
        All product batches
      </Link>
      <header className="atlas-heading">
        <div>
          <p className="atlas-eyebrow">Production / Batch record</p>
          <h1>{batch.productName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {batch.kind.replaceAll("_", " ")} / Started{" "}
            {formatDate(batch.startedAt)} /{" "}
            {batch.voidedAt
              ? "Voided"
              : batch.finishedAt
                ? "Finished"
                : "In progress"}
          </p>
        </div>
      </header>
      <section className="atlas-records">
        <div className="atlas-record">
          <h2 className="font-semibold">Inputs and source</h2>
          <p className="mt-2 text-sm">
            {batch.honeyLbs == null
              ? "Honey input not recorded"
              : formatLbs(batch.honeyLbs)}
            {batch.waterLiters ? ` / ${batch.waterLiters} L water` : ""}
            {batch.propolisAmount
              ? ` / ${batch.propolisAmount} ${batch.propolisUnit} propolis`
              : ""}
          </p>
          {batch.harvestLotId ? (
            <Link
              className="text-sm underline"
              href={`/production/lots/${batch.harvestLotId}`}
            >
              Source lot {batch.harvestLotCode}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">Origin not recorded</p>
          )}
          {batch.vessel && <p className="text-sm">Vessel: {batch.vessel}</p>}
        </div>
        <div className="atlas-record">
          <h2 className="font-semibold">Output and costs</h2>
          <p className="mt-2">{batch.quantityOut} units produced</p>
          <p className="text-sm text-muted-foreground">
            {formatMoney(batch.totalCost)} total cost /{" "}
            {formatMoney(batch.costPerUnit)} per unit
          </p>
          {batch.notes && (
            <p className="mt-3 whitespace-pre-wrap text-sm">{batch.notes}</p>
          )}
          {batch.voidReason && (
            <p className="text-sm text-destructive">
              Void reason: {batch.voidReason}
            </p>
          )}
        </div>
      </section>
      <Link href="/stock/finished" className="underline">
        Current finished stock
      </Link>
    </div>
  );
}
