"use client";

import { useState, useRef, useEffect } from "react";
import { useActionState } from "react";
import { uploadPhoto } from "@/actions/photos";
import { Button } from "@/components/ui/button";
import { Upload, X } from "lucide-react";

interface PhotoUploadProps {
  ownerType: string;
  ownerId: string;
}

export function PhotoUpload({ ownerType, ownerId }: PhotoUploadProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [state, formAction, isPending] = useActionState(uploadPhoto, null);

  // Clear form on successful upload
  useEffect(() => {
    if (state && typeof state === "object" && "success" in state && state.success) {
      setPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      formRef.current?.reset();
    }
  }, [state]);

  const handleFileSelect = (file: File | null) => {
    if (!file) {
      setPreview(null);
      return;
    }

    if (!file.type.startsWith("image/")) {
      alert("Please select an image file");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileSelect(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const clearPreview = () => {
    setPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <input type="hidden" name="ownerType" value={ownerType} />
      <input type="hidden" name="ownerId" value={ownerId} />

      {!preview ? (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="image/*"
            onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
            className="hidden"
          />
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground mb-2">
            Drag and drop an image, or
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Browse Files
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden border">
            <img
              src={preview}
              alt="Preview"
              className="w-full h-auto max-h-64 object-contain"
            />
            <button
              type="button"
              onClick={clearPreview}
              className="absolute top-2 right-2 p-1.5 bg-background/80 hover:bg-background rounded-full"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div>
            <label htmlFor="caption" className="text-sm font-medium block mb-1">
              Caption (optional)
            </label>
            <input
              id="caption"
              name="caption"
              type="text"
              placeholder="Add a caption..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Uploading..." : "Upload Photo"}
          </Button>

          {state && "error" in state && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}
        </div>
      )}
    </form>
  );
}
