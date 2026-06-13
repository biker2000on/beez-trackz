import { notFound } from "next/navigation";
import { getApiary, deleteApiary } from "@/actions/apiaries";
import { normalizeCanvasLayout } from "@/actions/canvas";
import { getHivesForApiary } from "@/actions/hives";
import { getPhotosForOwner } from "@/actions/photos";
import {
  getActiveBloomsForApiary,
  getBloomHistoryForApiary,
  getBloomSpeciesAutocomplete,
} from "@/actions/bloom-observations";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { HiveCard } from "@/components/hives/hive-card";
import { NewHiveDialog } from "@/components/hives/new-hive-dialog";
import { ApiaryCanvas } from "@/components/canvas/apiary-canvas";
import { PhotoGallery } from "@/components/photos/photo-gallery";
import { PhotoUpload } from "@/components/photos/photo-upload";
import { BloomForm } from "@/components/flora/bloom-form";
import { ActiveBlooms } from "@/components/flora/active-blooms";
import { BloomHistory } from "@/components/flora/bloom-history";
import { ApiaryRecordingHandler } from "@/components/recording/apiary-recording-handler";
import { BulkHiveForm } from "@/components/bulk/bulk-hive-form";
import { BulkInspectionForm } from "@/components/bulk/bulk-inspection-form";
import { BulkFeedingForm } from "@/components/bulk/bulk-feeding-form";
import { DeleteButton } from "@/components/shared/delete-button";
import type { CanvasLayout } from "@/lib/canvas/types";
import Link from "next/link";
import { Pencil, Plus, Flower2, ListChecks } from "lucide-react";

export default async function ApiaryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Migrate any legacy canvas layout (embedded slot occupancy) into the
  // hives table before reading. No-op for already-normalized layouts.
  await normalizeCanvasLayout(id);
  const [apiary, hives, photos, activeBlooms, bloomHistory, speciesList] = await Promise.all([
    getApiary(id),
    getHivesForApiary(id),
    getPhotosForOwner("apiary", id),
    getActiveBloomsForApiary(id),
    getBloomHistoryForApiary(id),
    getBloomSpeciesAutocomplete(id),
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
        <div className="flex items-center gap-2">
          <ApiaryRecordingHandler apiaryId={id} apiaryName={apiary.name} />
          <Link href={`/apiaries/${id}/edit`}>
            <Button variant="outline" size="sm">
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </Link>
          <DeleteButton
            onDelete={async () => {
              "use server";
              await deleteApiary(id);
            }}
            entityName="Apiary"
            warning="This will permanently delete this apiary. All associated hive locations and canvas layout will be lost. This action cannot be undone."
          />
        </div>
      </div>
      <Tabs defaultValue="hives">
        <TabsList>
          <TabsTrigger value="layout">Layout</TabsTrigger>
          <TabsTrigger value="hives">Hives</TabsTrigger>
          <TabsTrigger value="bulk">
            <ListChecks className="h-4 w-4 mr-2" />
            Bulk Actions
          </TabsTrigger>
          <TabsTrigger value="flora">
            <Flower2 className="h-4 w-4 mr-2" />
            Flora
          </TabsTrigger>
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
                notes: h.notes,
                standId: h.standId,
                slotRow: h.slotRow,
                slotCol: h.slotCol,
                placement: h.placement,
                facingDegrees: h.facingDegrees,
              }))}
              initialLayout={(apiary.canvasLayout as CanvasLayout) ?? null}
              latitude={apiary.latitude}
              longitude={apiary.longitude}
            />
          </div>
        </TabsContent>
        <TabsContent value="hives">
          <div className="p-4 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {hives.length} {hives.length === 1 ? "Hive" : "Hives"}
              </h2>
              <NewHiveDialog
                apiaries={[{ id, name: apiary.name }]}
                defaultApiaryId={id}
                triggerSize="sm"
              />
            </div>

            <BulkHiveForm apiaryId={id} />

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
                    isArchived={hive.isArchived}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="bulk">
          <div className="p-4 space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <BulkInspectionForm
                hives={hives.map((h) => ({
                  id: h.id,
                  positionLabel: h.positionLabel,
                }))}
              />
              <BulkFeedingForm
                hives={hives.map((h) => ({
                  id: h.id,
                  positionLabel: h.positionLabel,
                }))}
              />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="flora">
          <div className="p-4 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Add Bloom Observation
              </h3>
              <BloomForm apiaryId={id} speciesList={speciesList} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Active Blooms ({activeBlooms.length})
              </h3>
              <ActiveBlooms blooms={activeBlooms} apiaryId={id} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Bloom History
              </h3>
              <BloomHistory history={bloomHistory} />
            </div>
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
