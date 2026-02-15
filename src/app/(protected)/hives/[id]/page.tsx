import { notFound } from "next/navigation";
import Link from "next/link";
import { getHive, getHiveLocationHistory } from "@/actions/hives";
import { getQueensForHive } from "@/actions/queens";
import { getInspectionsForHive } from "@/actions/inspections";
import { getEquipmentForHive } from "@/actions/equipment";
import { getFeedingsForHive } from "@/actions/feedings";
import { getPhotosForOwner } from "@/actions/photos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { HiveDetailTabs } from "@/components/hives/hive-detail-tabs";
import { Pencil, ClipboardList, StickyNote, Camera, Droplets } from "lucide-react";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-200",
  dead: "bg-red-500/10 text-red-700 border-red-200",
  sold: "bg-blue-500/10 text-blue-700 border-blue-200",
  combined: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
};

export default async function HiveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [hive, locationHistory, queens, inspections, equipment, feedings, photos] = await Promise.all([
    getHive(id),
    getHiveLocationHistory(id),
    getQueensForHive(id),
    getInspectionsForHive(id),
    getEquipmentForHive(id),
    getFeedingsForHive(id),
    getPhotosForOwner("hive", id),
  ]);

  if (!hive) {
    notFound();
  }

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
        <Link href={`/hives/${id}/edit`}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </Link>
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
        <Button variant="outline" size="sm" asChild>
          <Link href={`/hives/${id}/inspections/new`}>
            <ClipboardList className="h-4 w-4 mr-2" />
            New Inspection
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/hives/${id}/notes/new`}>
            <StickyNote className="h-4 w-4 mr-2" />
            Record Note
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/hives/${id}/photos/new`}>
            <Camera className="h-4 w-4 mr-2" />
            Take Photo
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/hives/${id}/feedings/new`}>
            <Droplets className="h-4 w-4 mr-2" />
            Feed
          </Link>
        </Button>
      </div>

      <Separator className="mb-6" />

      {/* Tabs */}
      <HiveDetailTabs hiveId={id} locationHistory={locationHistory} queens={queens} inspections={inspections} equipment={equipment} feedings={feedings} photos={photos} />
    </div>
  );
}
