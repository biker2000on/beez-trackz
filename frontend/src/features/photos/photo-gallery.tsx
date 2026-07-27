"use client";

import * as React from "react";
import { Check, CheckSquare, ImageOff, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";
import { formatDate } from "@/features/hives/lib";
import { PhotoUpload } from "./photo-upload";
import {
  usePhotos,
  useBulkDeletePhotos,
  useDeletePhoto,
  useUpdatePhoto,
  type Photo,
  type PhotoOwnerType,
} from "./hooks";

/** Thumbnail grid with a detail dialog (medium image + caption/tags editing). */
export function PhotoGallery({
  ownerType,
  ownerId,
  canEdit = true,
}: {
  ownerType: PhotoOwnerType;
  ownerId: string;
  canEdit?: boolean;
}) {
  const photos = usePhotos(ownerType, ownerId);
  const bulkDelete = useBulkDeletePhotos(ownerType, ownerId);
  const [detailPhoto, setDetailPhoto] = React.useState<Photo | null>(null);
  const [bulkMode, setBulkMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  useShortcut("b", "Toggle bulk-select photos", () => {
    if (!canEdit) return;
    setBulkMode((active) => {
      if (active) setSelectedIds(new Set());
      return !active;
    });
  });
  useShortcut("x", "Select all photos", () => {
    if (!canEdit || !bulkMode) return;
    setSelectedIds(
      selectedIds.size === (photos.data?.length ?? 0)
        ? new Set()
        : new Set((photos.data ?? []).map((photo) => photo.id)),
    );
  });

  function togglePhoto(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    try {
      const count = await bulkDelete.mutateAsync(Array.from(selectedIds));
      toast.success(`${count} photo${count === 1 ? "" : "s"} deleted`);
      setSelectedIds(new Set());
      setBulkMode(false);
      setConfirmDelete(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Bulk delete failed");
    }
  }

  if (photos.isPending) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-md" />
        ))}
      </div>
    );
  }
  if (photos.isError) {
    return (
      <p className="text-sm text-muted-foreground">Could not load photos.</p>
    );
  }
  if (photos.data.length === 0) {
    return (
      <div className="grid place-items-center gap-2 rounded-lg border border-dashed p-6 text-center">
        <ImageOff className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No photos yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {photos.data.length} {photos.data.length === 1 ? "photo" : "photos"}
        </p>
        {canEdit ? (
          <Button
            variant={bulkMode ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              setBulkMode((active) => !active);
              setSelectedIds(new Set());
            }}
          >
            <CheckSquare />
            {bulkMode ? "Done" : "Bulk select"}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {photos.data.map((photo) => (
          <button
            key={photo.id}
            type="button"
            className={`group relative aspect-square overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              selectedIds.has(photo.id) ? "ring-2 ring-primary" : ""
            }`}
            onClick={() =>
              bulkMode ? togglePhoto(photo.id) : setDetailPhoto(photo)
            }
          >
            {/* API-served images are already resized; next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.thumbnailUrl ?? photo.originalUrl ?? ""}
              alt={photo.caption ?? "Photo"}
              loading="lazy"
              className="size-full object-cover transition-transform group-hover:scale-105"
            />
            {bulkMode && (
              <span
                className={`absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full border shadow-sm ${
                  selectedIds.has(photo.id)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card/90"
                }`}
              >
                {selectedIds.has(photo.id) && <Check className="size-4" />}
              </span>
            )}
          </button>
        ))}
      </div>
      {bulkMode && (
        <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelectedIds(
                selectedIds.size === photos.data.length
                  ? new Set()
                  : new Set(photos.data.map((photo) => photo.id)),
              )
            }
          >
            {selectedIds.size === photos.data.length ? "Clear all" : "Select all"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={selectedIds.size === 0}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
            Delete
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Exit bulk select"
            onClick={() => {
              setBulkMode(false);
              setSelectedIds(new Set());
            }}
          >
            <X />
          </Button>
        </div>
      )}
      <PhotoDetailDialog
        ownerType={ownerType}
        ownerId={ownerId}
        photo={detailPhoto}
        canEdit={canEdit}
        onClose={() => setDetailPhoto(null)}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} selected{" "}
              {selectedIds.size === 1 ? "photo" : "photos"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The original images and their resized copies will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDelete.isPending}
              onClick={(event) => {
                event.preventDefault();
                void deleteSelected();
              }}
            >
              {bulkDelete.isPending ? "Deleting…" : "Delete selected"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PhotoDetailDialog({
  ownerType,
  ownerId,
  photo,
  canEdit,
  onClose,
}: {
  ownerType: PhotoOwnerType;
  ownerId: string;
  photo: Photo | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const updatePhoto = useUpdatePhoto(ownerType, ownerId);
  const deletePhoto = useDeletePhoto(ownerType, ownerId);
  const [caption, setCaption] = React.useState("");
  const [tags, setTags] = React.useState("");

  React.useEffect(() => {
    if (photo) {
      // Sync the draft editor when the selected photo changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCaption(photo.caption ?? "");
      setTags((photo.tags ?? []).join(", "));
    }
  }, [photo]);

  async function onSave() {
    if (!photo) return;
    try {
      await updatePhoto.mutateAsync({
        id: photo.id,
        caption: caption.trim() === "" ? null : caption,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      toast.success("Photo updated");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not update photo",
      );
    }
  }

  async function onDelete() {
    if (!photo) return;
    try {
      await deletePhoto.mutateAsync(photo.id);
      toast.success("Photo deleted");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not delete photo",
      );
    }
  }

  return (
    <Dialog open={Boolean(photo)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Photo</DialogTitle>
          <DialogDescription>
            {photo?.takenDate
              ? `Taken ${formatDate(photo.takenDate)}`
              : photo
                ? `Added ${formatDate(photo.createdAt)}`
                : ""}
          </DialogDescription>
        </DialogHeader>
        {photo && (
          <div className="grid gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.mediumUrl ?? photo.originalUrl ?? ""}
              alt={photo.caption ?? "Photo"}
              className="max-h-96 w-full rounded-md object-contain"
            />
            {canEdit ? <div className="grid gap-2">
              <Label htmlFor="photo-detail-caption">Caption</Label>
              <Input
                id="photo-detail-caption"
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
              />
            </div> : null}
            {canEdit ? <div className="grid gap-2">
              <Label htmlFor="photo-detail-tags">Tags</Label>
              <Input
                id="photo-detail-tags"
                placeholder="Comma-separated, e.g. queen, brood"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </div> : null}
            {canEdit ? <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="destructive"
                onClick={onDelete}
                disabled={deletePhoto.isPending}
              >
                <Trash2 className="size-4" />
                {deletePhoto.isPending ? "Deleting…" : "Delete"}
              </Button>
              <Button
                type="button"
                onClick={onSave}
                disabled={updatePhoto.isPending}
              >
                {updatePhoto.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Upload + gallery combo used by the apiary and hive photo tabs. */
export function PhotoSection({
  ownerType,
  ownerId,
  canEdit = true,
}: {
  ownerType: PhotoOwnerType;
  ownerId: string;
  canEdit?: boolean;
}) {
  return (
    <div className="grid gap-4">
      {canEdit ? <PhotoUpload ownerType={ownerType} ownerId={ownerId} /> : null}
      <PhotoGallery ownerType={ownerType} ownerId={ownerId} canEdit={canEdit} />
    </div>
  );
}
