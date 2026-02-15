"use client";

import { useState } from "react";
import { RecordingButton } from "./recording-button";

interface ApiaryRecordingHandlerProps {
  apiaryId: string;
  apiaryName: string;
}

export function ApiaryRecordingHandler({ apiaryId, apiaryName }: ApiaryRecordingHandlerProps) {
  const [isUploading, setIsUploading] = useState(false);

  const handleRecordingComplete = async (blob: Blob) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("audio", blob, "recording.webm");
      formData.append("ownerType", "apiary");
      formData.append("ownerId", apiaryId);
      formData.append("mode", "batch");

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        console.error("Upload failed:", response.statusText);
      }
    } catch (error) {
      console.error("Upload error:", error);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <RecordingButton
        mode="batch"
        onRecordingComplete={handleRecordingComplete}
        variant="outline"
        size="sm"
      />
      {isUploading && (
        <span className="text-sm text-muted-foreground">Uploading...</span>
      )}
    </div>
  );
}
