"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { AudioRecorder } from "./audio-recorder";
import { Mic } from "lucide-react";

interface RecordingButtonProps {
  hiveId?: string;
  hiveName?: string;
  mode?: "single" | "batch";
  onRecordingComplete: (blob: Blob) => void;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export function RecordingButton({
  hiveId,
  hiveName,
  mode = "single",
  onRecordingComplete,
  variant = "default",
  size = "default",
  className,
}: RecordingButtonProps) {
  const [open, setOpen] = useState(false);

  const handleComplete = (audioBlob: Blob) => {
    onRecordingComplete(audioBlob);
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          <Mic className="h-4 w-4 mr-2" />
          Record Audio
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[90vh]">
        <SheetHeader>
          <SheetTitle>
            {mode === "batch" ? "Record Audio for All Hives" : "Record Audio Note"}
          </SheetTitle>
          <SheetDescription>
            {mode === "batch"
              ? "Record a voice note that will be attached to all hives"
              : "Record a voice note for this hive inspection"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6">
          <AudioRecorder
            mode={mode}
            hiveId={hiveId}
            hiveName={hiveName}
            onComplete={handleComplete}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
