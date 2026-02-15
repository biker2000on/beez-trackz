"use client";

import { useState } from "react";
import { PhotoDetail } from "./photo-detail";

interface Photo {
  id: string;
  thumbnailPath: string | null;
  mediumPath: string | null;
  originalPath: string;
  caption: string | null;
  tags: unknown;
  takenDate: Date | null;
  ownerType: string;
  ownerId: string;
}

interface PhotoGalleryProps {
  photos: Photo[];
  ownerType: string;
  ownerId: string;
}

export function PhotoGallery({ photos, ownerType, ownerId }: PhotoGalleryProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  if (photos.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No photos yet
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
        {photos.map((photo) => {
          const imagePath = photo.thumbnailPath
            ? `/api/photos/${ownerType}/${ownerId}/${photo.thumbnailPath.split("/").pop()}`
            : `/api/photos/${ownerType}/${ownerId}/${photo.originalPath.split("/").pop()}`;

          return (
            <button
              key={photo.id}
              onClick={() => setSelectedPhoto(photo)}
              className="relative aspect-square rounded-md overflow-hidden border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <img
                src={imagePath}
                alt={photo.caption || "Photo"}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          );
        })}
      </div>

      {selectedPhoto && (
        <PhotoDetail
          photo={selectedPhoto}
          ownerType={ownerType}
          ownerId={ownerId}
          onClose={() => setSelectedPhoto(null)}
        />
      )}
    </>
  );
}
