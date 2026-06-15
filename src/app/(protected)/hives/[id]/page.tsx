import { notFound } from "next/navigation";
import Link from "next/link";
import { getHive, getHiveLocationHistory } from "@/actions/hives";
import { getApiaries } from "@/actions/apiaries";
import { getHives } from "@/actions/hives";
import { getQueensForHive } from "@/actions/queens";
import { getAllQueens } from "@/actions/queens";
import { getInspectionsForHive } from "@/actions/inspections";
import { getDeploymentsForHive } from "@/actions/equipment-v2";
import { getFeedingsForHive } from "@/actions/feedings";
import { getPhotosForOwner } from "@/actions/photos";
import { getSplitsForHive } from "@/actions/hive-splits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { HiveDetailTabs } from "@/components/hives/hive-detail-tabs";
import { HiveEditModal } from "@/components/hives/hive-edit-modal-page";
import {
  FeedingDialog,
  HivePhotoDialog,
  NewInspectionDialog,
  QuickInspectionDialog,
  SplitHiveDialog,
} from "@/components/hives/hive-action-dialogs";
import { archiveHive, unarchiveHive, markDeadout } from "@/actions/hives";
import { ClipboardList, Camera, Droplets, Mic, GitBranch, Archive, ArchiveRestore, Skull } from "lucide-react";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-200 dark:text-green-400 dark:border-green-800",
  dead: "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-800",
  sold: "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-800",
  combined: "bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-800",
};

export default async function HiveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [
    hive,
    locationHistory,
    queens,
    inspections,
    equipment,
    feedings,
    photos,
    splits,
    allHives,
    allQueens,
    apiaries,
  ] = await Promise.all([
    getHive(id),
    getHiveLocationHistory(id),
    getQueensForHive(id),
    getInspectionsForHive(id),
    getDeploymentsForHive(id),
    getFeedingsForHive(id),
    getPhotosForOwner("hive", id),
    getSplitsForHive(id),
    getHives(),
    getAllQueens(),
    getApiaries(),
  ]);

  if (!hive) {
    notFound();
  }

  const hiveOptions = allHives.map((h) => ({
    id: h.id,
    name: `${h.apiaryName} - ${h.positionLabel}`,
  }));
  const queenOptions = allQueens.map((q) => ({
    id: q.id,
    label: `${q.hiveName || q.origin} (${q.status})`,
  }));
  const apiaryOptions = apiaries.map((apiary) => ({
    id: apiary.id,
    name: apiary.name,
  }));

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{hive.positionLabel}</h1>
          <Badge variant="outline" className={statusColors[hive.status] || ""}>
            {hive.status}
          </Badge>
        </div>
        <HiveEditModal hiveId={id} defaultValues={hive} />
      </div>

      <p className="text-muted-foreground mb-4">
        <Link
          href={`/apiaries/${hive.apiaryId}`}
          className="hover:underline"
        >
          {hive.apiaryName}
        </Link>
        {hive.installedDate && (
          <span>
            {" "}
            &middot; Installed{" "}
            {new Date(hive.installedDate).toLocaleDateString()}
          </span>
        )}
      </p>

      {hive.notes && (
        <p className="text-sm text-muted-foreground mb-4">{hive.notes}</p>
      )}

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        <NewInspectionDialog hiveId={id} hiveLabel={hive.positionLabel}>
          <>
            <ClipboardList className="h-4 w-4 mr-2" />
            New Inspection
          </>
        </NewInspectionDialog>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/hives/${id}/transcribe`}>
            <Mic className="h-4 w-4 mr-2" />
            Record Inspection
          </Link>
        </Button>
        <QuickInspectionDialog hiveId={id} hiveLabel={hive.positionLabel}>
          <>
            <ClipboardList className="h-4 w-4 mr-2" />
            Quick Inspection
          </>
        </QuickInspectionDialog>
        <HivePhotoDialog hiveId={id} hiveLabel={hive.positionLabel}>
          <>
            <Camera className="h-4 w-4 mr-2" />
            Take Photo
          </>
        </HivePhotoDialog>
        <FeedingDialog hiveId={id} hiveLabel={hive.positionLabel}>
          <>
            <Droplets className="h-4 w-4 mr-2" />
            Feed
          </>
        </FeedingDialog>
        <SplitHiveDialog
          hiveId={id}
          hiveLabel={hive.positionLabel}
          apiaryId={hive.apiaryId}
          apiaries={apiaryOptions}
        >
          <>
            <GitBranch className="h-4 w-4 mr-2" />
            Split Hive
          </>
        </SplitHiveDialog>
        {!hive.isArchived && hive.status === "active" && (
          <>
            <form action={async () => { "use server"; await archiveHive(id); }}>
              <Button variant="outline" size="sm" type="submit">
                <Archive className="h-4 w-4 mr-2" />
                Archive
              </Button>
            </form>
            <form action={async () => { "use server"; await markDeadout(id); }}>
              <Button variant="destructive" size="sm" type="submit">
                <Skull className="h-4 w-4 mr-2" />
                Deadout
              </Button>
            </form>
          </>
        )}
        {hive.isArchived && (
          <form action={async () => { "use server"; await unarchiveHive(id); }}>
            <Button variant="outline" size="sm" type="submit">
              <ArchiveRestore className="h-4 w-4 mr-2" />
              Unarchive
            </Button>
          </form>
        )}
      </div>

      <Separator className="mb-6" />

      {/* Tabs */}
      <HiveDetailTabs
        hiveId={id}
        hiveLabel={hive.positionLabel}
        hives={hiveOptions}
        queenOptions={queenOptions}
        locationHistory={locationHistory}
        queens={queens}
        inspections={inspections}
        equipment={equipment}
        feedings={feedings}
        photos={photos}
        splits={splits}
      />
    </div>
  );
}
