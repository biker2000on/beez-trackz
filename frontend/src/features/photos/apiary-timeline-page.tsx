"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { useApiary } from "@/features/apiaries/hooks";
import { ApiaryPhotoTimeline } from "./timeline";

export function ApiaryTimelinePage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(apiaryRole(access.data, apiaryId) ?? "");

  if (apiary.isPending) return <Skeleton className="h-80 w-full" />;
  if (apiary.isError || !apiary.data) {
    return <p className="text-sm text-muted-foreground">Could not load this apiary.</p>;
  }

  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-3 w-fit">
          <Link href={`/apiaries/${apiaryId}`}>
            <ArrowLeft />
            {apiary.data.name}
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Yard timeline</h1>
          <p className="text-sm text-muted-foreground">
            Seasonal flora and hive-front evidence discovered in Immich near this apiary.
          </p>
        </div>
      </header>
      <ApiaryPhotoTimeline apiaryId={apiaryId} canEdit={canEdit} />
    </div>
  );
}
