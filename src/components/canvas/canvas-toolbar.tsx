"use client";

import { ZoomIn, ZoomOut, Maximize, Lock, Unlock, Save, Map } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

interface CanvasToolbarProps {
  editMode: boolean;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  satelliteEnabled?: boolean;
  satelliteOpacity?: number;
  onToggleEditMode: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onSave: () => void;
  onToggleSatellite?: () => void;
  onSatelliteOpacityChange?: (opacity: number) => void;
}

export function CanvasToolbar({
  editMode,
  hasUnsavedChanges,
  isSaving,
  satelliteEnabled = false,
  satelliteOpacity = 0.7,
  onToggleEditMode,
  onZoomIn,
  onZoomOut,
  onResetView,
  onSave,
  onToggleSatellite,
  onSatelliteOpacityChange,
}: CanvasToolbarProps) {
  return (
    <div className="flex flex-col gap-2">
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

      {onToggleSatellite && (
        <>
          <div className="w-px h-6 bg-border" />
          <Button
            variant={satelliteEnabled ? "default" : "outline"}
            size="sm"
            onClick={onToggleSatellite}
            title="Toggle Satellite Overlay"
          >
            <Map className="h-4 w-4 mr-1" />
            Satellite
          </Button>
        </>
      )}
      </div>

      {satelliteEnabled && onSatelliteOpacityChange && (
        <div className="flex items-center gap-2 p-2 bg-background border rounded-lg shadow-sm">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Opacity:
          </span>
          <Slider
            value={[satelliteOpacity * 100]}
            onValueChange={(values) => onSatelliteOpacityChange(values[0] / 100)}
            min={0}
            max={100}
            step={5}
            className="w-32"
          />
          <span className="text-xs text-muted-foreground w-8">
            {Math.round(satelliteOpacity * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}
