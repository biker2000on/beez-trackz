"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { PhotoSection } from "@/features/photos/photo-gallery";
import { FloraTab } from "./flora-tab";
import { useApiary } from "./hooks";

export function ApiarySubpage({
  apiaryId,
  section,
}: {
  apiaryId: string;
  section: "flora" | "photos";
}) {
  const apiary = useApiary(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );

  if (apiary.isPending) return <Skeleton className="h-72 w-full" />;
  if (apiary.isError || !apiary.data) {
    return <p className="text-sm text-muted-foreground">Could not load this apiary.</p>;
  }

  const title = section === "flora" ? "Flora" : "Photos";
  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-3 w-fit">
          <Link href={`/yard/apiaries/${apiaryId}`}>
            <ArrowLeft />
            {apiary.data.name}
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {section === "flora"
              ? "Bloom records and forage conditions for this yard."
              : "The yard photo gallery and uploads."}
          </p>
        </div>
      </header>
      {section === "flora" ? (
        <FloraTab apiaryId={apiaryId} canEdit={canEdit} />
      ) : (
        <PhotoSection ownerType="apiary" ownerId={apiaryId} canEdit={canEdit} />
      )}
    </div>
  );
}
