"use client";

import * as React from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { cn } from "@/lib/utils";
import {
  useLinkPhoto,
  usePhotoLibrary,
  usePhotoStorage,
  useUploadPhoto,
  type PhotoOwnerType,
} from "./hooks";

/**
 * Drag-drop / browse photo uploader with preview and caption.
 * Fully controlled; revokes object URLs on change/unmount.
 */
export function PhotoUpload({
  ownerType,
  ownerId,
  onUploaded,
}: {
  ownerType: PhotoOwnerType;
  ownerId: string;
  onUploaded?: () => void;
}) {
  const upload = useUploadPhoto();
  const storage = usePhotoStorage();
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const library = usePhotoLibrary(
    Boolean(storage.data?.immichConfigured && libraryOpen),
  );
  const linkPhoto = useLinkPhoto();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [caption, setCaption] = React.useState("");
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function selectFile(next: File | null) {
    if (next && !next.type.startsWith("image/")) {
      toast.error("Only image files can be uploaded");
      return;
    }
    if (next && next.size > 10 * 1024 * 1024) {
      toast.error("Photo must be under 10MB");
      return;
    }
    setFile(next);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return next ? URL.createObjectURL(next) : null;
    });
  }

  async function onUpload() {
    if (!file) return;
    try {
      await upload.mutateAsync({ file, ownerType, ownerId, caption });
      toast.success("Photo uploaded");
      selectFile(null);
      setCaption("");
      if (inputRef.current) inputRef.current.value = "";
      onUploaded?.();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not upload photo",
      );
    }
  }

  return (
    <ShortcutForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onUpload();
      }}
    >
      <div
        className={cn(
          "relative grid place-items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          selectFile(event.dataTransfer.files?.[0] ?? null);
        }}
      >
        {previewUrl ? (
          <div className="relative">
            {/* Local object URL preview — next/image can't optimize blobs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Selected photo preview"
              className="max-h-48 rounded-md object-contain"
            />
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="absolute -right-2 -top-2 rounded-full shadow"
              aria-label="Remove selected photo"
              onClick={() => selectFile(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="grid justify-items-center gap-2">
            <ImagePlus className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Drag a photo here, or
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              Browse files
            </Button>
            {storage.data?.immichConfigured ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLibraryOpen((open) => !open)}
              >
                Link from library
              </Button>
            ) : null}
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
        />
      </div>
      {libraryOpen && storage.data?.immichConfigured && (
        <div className="grid gap-2 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">
            Adopt an Immich image. The library original is not copied or
            deleted.
          </p>
          {library.isPending ? (
            <p className="text-sm text-muted-foreground">Loading library…</p>
          ) : library.isError ? (
            <p className="text-sm text-destructive">
              Could not load Immich library.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(library.data?.pages ?? [])
                .flatMap((page) => page.items)
                .map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className="overflow-hidden rounded-md border text-left"
                    disabled={linkPhoto.isPending}
                    onClick={async () => {
                      try {
                        await linkPhoto.mutateAsync({
                          assetId: asset.id,
                          ownerType,
                          ownerId,
                        });
                        toast.success("Photo linked from library");
                        setLibraryOpen(false);
                        onUploaded?.();
                      } catch (error) {
                        toast.error(
                          error instanceof ApiError
                            ? error.message
                            : "Could not link photo",
                        );
                      }
                    }}
                  >
                    {/* Immich thumbs are proxied by the API. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.originalFileName}
                      className="aspect-square w-full object-cover"
                    />
                    <span className="block truncate px-1 py-0.5 text-[11px] text-muted-foreground">
                      {asset.originalFileName}
                    </span>
                  </button>
                ))}
            </div>
          )}
          {library.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={library.isFetchingNextPage}
              onClick={() => void library.fetchNextPage()}
            >
              {library.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
      {file && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="photo-caption">Caption</Label>
            <Input
              id="photo-caption"
              placeholder="Optional caption"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={upload.isPending}
          >
            {upload.isPending ? "Uploading…" : "Upload photo"}
          </Button>
        </>
      )}
    </ShortcutForm>
  );
}
