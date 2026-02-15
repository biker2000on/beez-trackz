"use client";

import { ZoomIn, ZoomOut, Maximize, Lock, Unlock, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CanvasToolbarProps {
  editMode: boolean;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  onToggleEditMode: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onSave: () => void;
}

export function CanvasToolbar({
  editMode,
  hasUnsavedChanges,
  isSaving,
  onToggleEditMode,
  onZoomIn,
  onZoomOut,
  onResetView,
  onSave,
}: CanvasToolbarProps) {
  return (
    <div className="flex items-center gap-2 p-2 bg-background border rounded-lg shadow-sm">
      <Button
        variant={editMode ? "default" : "outline"}
        size="sm"
        onClick={onToggleEditMode}
        title={editMode ? "Switch to View Mode" : "Switch to Edit Mode"}
      >
        {editMode ? (
          <>
            <Unlock className="h-4 w-4 mr-1" />
            Edit
          </>
        ) : (
          <>
            <Lock className="h-4 w-4 mr-1" />
            View
          </>
        )}
      </Button>

      <div className="w-px h-6 bg-border" />

      <Button variant="outline" size="icon" onClick={onZoomIn} title="Zoom In">
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={onZoomOut}
        title="Zoom Out"
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        onClick={onResetView}
        title="Fit All Hives"
      >
        <Maximize className="h-4 w-4" />
      </Button>

      <div className="w-px h-6 bg-border" />

      <Button
        variant={hasUnsavedChanges ? "default" : "outline"}
        size="sm"
        onClick={onSave}
        disabled={!hasUnsavedChanges || isSaving}
        title="Save Layout"
      >
        <Save className="h-4 w-4 mr-1" />
        {isSaving ? "Saving..." : hasUnsavedChanges ? "Save" : "Saved"}
      </Button>
    </div>
  );
}
