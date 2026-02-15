"use client";

import { useState, useEffect } from "react";
import { getTranscriptionStatus, parseTranscriptionText } from "@/actions/transcription";
import { ReviewPanel } from "./review-panel";
import { BatchReview } from "./batch-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import type { TranscriptionResult } from "@/lib/ai/transcription-parser";

interface TranscriptionStatusProps {
  mediaFileId: string;
  mode: "single" | "batch";
  onComplete: () => void;
}

type Status = "pending" | "processing" | "complete" | "failed";

export function TranscriptionStatus({ mediaFileId, mode, onComplete }: TranscriptionStatusProps) {
  const [status, setStatus] = useState<Status>("pending");
  const [rawText, setRawText] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  useEffect(() => {
    let pollInterval: NodeJS.Timeout | null = null;

    const checkStatus = async () => {
      try {
        const result = await getTranscriptionStatus(mediaFileId);

        if ("error" in result) {
          setError(result.error ?? "Unknown error");
          setStatus("failed");
          setIsPolling(false);
          return;
        }

        setStatus(result.status as Status);

        if (result.status === "complete") {
          setRawText(result.rawText || null);
          // Parse the transcription text
          if (result.rawText && !result.rawText.startsWith("Error:")) {
            try {
              const parsed = await parseTranscriptionText(result.rawText, mode);
              setParsedData(parsed);
            } catch (err) {
              console.error("Failed to parse transcription:", err);
              setError("Failed to parse transcription text");
            }
          } else if (result.rawText?.startsWith("Error:")) {
            setError(result.rawText);
          }
          setIsPolling(false);
        } else if (result.status === "failed") {
          setError(result.rawText || "Transcription failed");
          setIsPolling(false);
        }
      } catch (err) {
        console.error("Error checking transcription status:", err);
        setError("Failed to check transcription status");
        setIsPolling(false);
      }
    };

    // Initial check
    checkStatus();

    // Poll every 3 seconds while processing
    if (isPolling) {
      pollInterval = setInterval(checkStatus, 3000);
    }

    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [mediaFileId, mode, isPolling]);

  const handleRetry = () => {
    setStatus("pending");
    setError(null);
    setIsPolling(true);
  };

  if (status === "pending" || status === "processing") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Processing Transcription</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <div className="text-center">
            <p className="text-lg font-medium mb-1">
              {status === "pending" ? "Queued for transcription..." : "Transcribing audio..."}
            </p>
            <p className="text-sm text-muted-foreground">
              This may take a few moments depending on the length of your recording
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status === "failed" || error) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            Transcription Failed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {error || "An error occurred while transcribing your audio"}
          </p>
          <Button onClick={handleRetry} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status === "complete" && parsedData) {
    if (mode === "single") {
      return (
        <ReviewPanel
          mediaFileId={mediaFileId}
          rawText={parsedData.rawText}
          initialInspection={parsedData.inspections[0] || {}}
          mode={mode}
          onComplete={onComplete}
        />
      );
    } else {
      return (
        <BatchReview
          mediaFileId={mediaFileId}
          rawText={parsedData.rawText}
          initialInspections={parsedData.inspections}
          onComplete={onComplete}
        />
      );
    }
  }

  return (
    <Card>
      <CardContent className="py-8">
        <p className="text-center text-muted-foreground">No transcription data available</p>
      </CardContent>
    </Card>
  );
}
