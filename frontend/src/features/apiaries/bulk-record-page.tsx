"use client";

/**
 * Bulk recording for one yard (/apiaries/[id]/bulk): the same inspection or
 * feeding across several hives at once. A workflow with its own route rather
 * than a tab, so it can be linked, resumed, and left without losing the
 * apiary page's state.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { BulkActionsTab } from "./bulk-actions-tab";
import { useApiary } from "./hooks";

export function BulkRecordPage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5">
      <header className="grid gap-1">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-3 w-fit text-muted-foreground"
        >
          <Link href={`/apiaries/${apiaryId}`}>
            <ArrowLeft />
            {apiary.data?.name ?? "Apiary"}
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Bulk record</h1>
        <p className="text-sm text-muted-foreground">
          Record the same inspection or feeding across several hives in
          {apiary.data ? ` ${apiary.data.name}` : " this yard"} at once.
        </p>
      </header>
      {apiary.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <BulkActionsTab apiaryId={apiaryId} />
      )}
    </div>
  );
}
