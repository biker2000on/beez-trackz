"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { AudioRecorder } from "@/components/recording/audio-recorder";
import { TranscriptionStatus } from "@/components/transcription/transcription-status";
import { uploadAudioForTranscription } from "@/actions/transcription";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function HiveTranscribePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const hiveId = resolvedParams.id;
  const router = useRouter();

  const [mediaFileId, setMediaFileId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleRecordingComplete = async (audioBlob: Blob, mode: string) => {
    setUploadError(null);

    const formData = new FormData();
    formData.append("audioBlob", audioBlob, "recording.webm");
    formData.append("ownerType", "hive");
    formData.append("ownerId", hiveId);
    formData.append("mode", mode);

    try {
      const result = await uploadAudioForTranscription(formData);
      if (result.error) {
        setUploadError(result.error);
      } else if (result.mediaFileId) {
        setMediaFileId(result.mediaFileId);
      }
    } catch (err) {
      console.error("Upload error:", err);
      setUploadError("Failed to upload audio");
    }
  };

  const handleTranscriptionComplete = () => {
    router.push(`/hives/${hiveId}`);
  };

  return (
    <div className="container max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <Link href={`/hives/${hiveId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Hive
          </Button>
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Record Inspection</h1>
        <p className="text-muted-foreground">
          Record your inspection notes and we&apos;ll transcribe them into structured data
        </p>
      </div>

      {uploadError && (
        <div className="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive">
          {uploadError}
        </div>
      )}

      {!mediaFileId ? (
        <AudioRecorder
          mode="single"
          hiveId={hiveId}
          onComplete={handleRecordingComplete}
        />
      ) : (
        <TranscriptionStatus
          mediaFileId={mediaFileId}
          mode="single"
          onComplete={handleTranscriptionComplete}
        />
      )}
    </div>
  );
}
