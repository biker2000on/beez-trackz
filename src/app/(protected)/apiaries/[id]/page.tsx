import { notFound } from "next/navigation";
import { getApiary } from "@/actions/apiaries";
import { getHivesForApiary } from "@/actions/hives";
import { getPhotosForOwner } from "@/actions/photos";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { HiveCard } from "@/components/hives/hive-card";
import { ApiaryCanvas } from "@/components/canvas/apiary-canvas";
import { PhotoGallery } from "@/components/photos/photo-gallery";
import { PhotoUpload } from "@/components/photos/photo-upload";
import type { CanvasLayout } from "@/actions/canvas";
import Link from "next/link";
import { Pencil, Plus } from "lucide-react";

export default async function ApiaryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [apiary, hives, photos] = await Promise.all([
    getApiary(id),
    getHivesForApiary(id),
    getPhotosForOwner("apiary", id),
  ]);

  if (!apiary) {
    notFound();
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{apiary.name}</h1>
          {apiary.notes && (
            <p className="text-muted-foreground mt-1">{apiary.notes}</p>
          )}
        </div>
        <Link href={`/apiaries/${id}/edit`}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </Link>
      </div>
      <Tabs defaultValue="hives">
        <TabsList>
          <TabsTrigger value="layout">Layout</TabsTrigger>
          <TabsTrigger value="hives">Hives</TabsTrigger>
          <TabsTrigger value="photos">Photos</TabsTrigger>
        </TabsList>
        <TabsContent value="layout">
          <div className="p-4">
            <ApiaryCanvas
              apiaryId={id}
              hives={hives.map((h) => ({
                id: h.id,
                positionLabel: h.positionLabel,
                status: h.status,
              }))}
              initialLayout={(apiary.canvasLayout as CanvasLayout) ?? null}
              latitude={apiary.latitude}
              longitude={apiary.longitude}
            />
          </div>
        </TabsContent>
        <TabsContent value="hives">
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                {hives.length} {hives.length === 1 ? "Hive" : "Hives"}
              </h2>
              <Link href={`/hives/new?apiaryId=${id}`}>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Hive
                </Button>
              </Link>
            </div>
            {hives.length === 0 ? (
              <p className="text-muted-foreground">
                No hives in this apiary yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {hives.map((hive) => (
                  <HiveCard
                    key={hive.id}
                    id={hive.id}
                    positionLabel={hive.positionLabel}
                    status={hive.status}
                    apiaryName={hive.apiaryName}
                    installedDate={hive.installedDate}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="photos">
          <div className="p-4 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Upload Photo
              </h3>
              <PhotoUpload ownerType="apiary" ownerId={id} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Gallery ({photos.length})
              </h3>
              <PhotoGallery photos={photos} ownerType="apiary" ownerId={id} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
