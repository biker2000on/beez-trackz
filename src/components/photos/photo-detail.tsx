"use client";

import { useState } from "react";
import { updatePhotoCaption, deletePhoto } from "@/actions/photos";
import { Button } from "@/components/ui/button";
import { X, Trash2, Save } from "lucide-react";

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

interface PhotoDetailProps {
  photo: Photo;
  ownerType: string;
  ownerId: string;
  onClose: () => void;
}

export function PhotoDetail({ photo, ownerType, ownerId, onClose }: PhotoDetailProps) {
  const photoTags = Array.isArray(photo.tags) ? photo.tags : [];
  const [caption, setCaption] = useState(photo.caption || "");
  const [tagsInput, setTagsInput] = useState(photoTags.join(", "));
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const imagePath = photo.mediumPath
    ? `/api/photos/${ownerType}/${ownerId}/${photo.mediumPath.split("/").pop()}`
    : `/api/photos/${ownerType}/${ownerId}/${photo.originalPath.split("/").pop()}`;

  const handleSave = async () => {
    setIsSaving(true);
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await updatePhotoCaption(photo.id, caption, tags);
    setIsSaving(false);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    await deletePhoto(photo.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border rounded-lg shadow-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold">Photo Details</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-lg overflow-hidden border">
            <img
              src={imagePath}
              alt={photo.caption || "Photo"}
              className="w-full h-auto"
            />
          </div>

          <div>
            <label htmlFor="edit-caption" className="text-sm font-medium block mb-1">
              Caption
            </label>
            <textarea
              id="edit-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a caption..."
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
            />
          </div>

          <div>
            <label htmlFor="edit-tags" className="text-sm font-medium block mb-1">
              Tags
            </label>
            <input
              id="edit-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="queen, brood, honey (comma separated)"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {tagsInput && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tagsInput
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((tag, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                    >
                      {tag}
                    </span>
                  ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button
              onClick={handleSave}
              disabled={isSaving}
              size="sm"
              className="flex-1"
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? "Saving..." : "Save Changes"}
            </Button>

            {!showDeleteConfirm ? (
              <Button
                onClick={() => setShowDeleteConfirm(true)}
                variant="destructive"
                size="sm"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            ) : (
              <Button
                onClick={handleDelete}
                disabled={isDeleting}
                variant="destructive"
                size="sm"
              >
                {isDeleting ? "Deleting..." : "Confirm Delete"}
              </Button>
            )}
          </div>

          {photo.takenDate && (
            <p className="text-xs text-muted-foreground">
              Taken: {new Date(photo.takenDate).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
