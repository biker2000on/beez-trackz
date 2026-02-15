"use client";

import { useState, useCallback, useEffect } from "react";
import { useActionState } from "react";
import { parseImportedFile } from "@/actions/import";
import type { ParsedImportData } from "@/lib/import/parser";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Upload, FileText, Loader2 } from "lucide-react";

interface FileUploadProps {
  onParsed: (data: ParsedImportData) => void;
}

export function FileUpload({ onParsed }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [state, formAction, isPending] = useActionState(parseImportedFile, null);

  useEffect(() => {
    if (state && "success" in state && state.success && "data" in state) {
      onParsed(state.data as ParsedImportData);
    }
  }, [state, onParsed]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      setFile(droppedFile);
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
    }
  }, []);

  const handleSubmit = useCallback(
    (formData: FormData) => {
      formAction(formData);
    },
    [formAction]
  );

  return (
    <div className="space-y-4">
      <Card
        className={`border-2 border-dashed transition-colors ${
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Upload className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground mb-2">
            Drag and drop your file here, or click to browse
          </p>
          <input
            type="file"
            id="file-upload"
            className="hidden"
            accept=".md,.txt,.csv,.json,audio/*,video/*"
            onChange={handleFileChange}
            disabled={isPending}
          />
          <label htmlFor="file-upload">
            <Button variant="outline" asChild disabled={isPending}>
              <span>Browse Files</span>
            </Button>
          </label>
          <p className="text-xs text-muted-foreground mt-4">
            Supported: Markdown, Text, CSV, JSON, Audio, Video
          </p>
        </CardContent>
      </Card>

      {file && (
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
          </div>
          <Button
            onClick={() => {
              const formData = new FormData();
              formData.append("file", file);
              handleSubmit(formData);
            }}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Parsing...
              </>
            ) : (
              "Parse File"
            )}
          </Button>
        </div>
      )}

      {state && "error" in state && state.error && (
        <div className="p-4 bg-destructive/10 text-destructive rounded-lg">
          <p className="font-medium">Error parsing file</p>
          <p className="text-sm">{state.error}</p>
        </div>
      )}
    </div>
  );
}
