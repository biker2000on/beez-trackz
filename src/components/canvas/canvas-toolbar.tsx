"use client";

import { useState } from "react";
import { ZoomIn, ZoomOut, Maximize, Lock, Unlock, Save, Map, Grid3x3, Hexagon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  onAddStand?: (rows: number, cols: number) => void;
  onAddHive?: () => void;
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
  onAddStand,
  onAddHive,
}: CanvasToolbarProps) {
  const [standRows, setStandRows] = useState(2);
  const [standCols, setStandCols] = useState(2);
  const [standPopoverOpen, setStandPopoverOpen] = useState(false);

  const handleCreateStand = () => {
    if (onAddStand) {
      onAddStand(standRows, standCols);
      setStandPopoverOpen(false);
    }
  };

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

      {editMode && (onAddStand || onAddHive) && (
        <>
          <div className="w-px h-6 bg-border" />

          {onAddStand && (
            <Popover open={standPopoverOpen} onOpenChange={setStandPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" title="Add Stand">
                  <Grid3x3 className="h-4 w-4 mr-1" />
                  Add Stand
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm">Create Stand</h4>
                    <p className="text-xs text-muted-foreground">
                      Choose the dimensions for the new stand
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="rows" className="text-xs">
                        Rows
                      </Label>
                      <Input
                        id="rows"
                        type="number"
                        min={1}
                        max={8}
                        value={standRows}
                        onChange={(e) => setStandRows(Math.min(8, Math.max(1, parseInt(e.target.value) || 1)))}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="cols" className="text-xs">
                        Columns
                      </Label>
                      <Input
                        id="cols"
                        type="number"
                        min={1}
                        max={8}
                        value={standCols}
                        onChange={(e) => setStandCols(Math.min(8, Math.max(1, parseInt(e.target.value) || 1)))}
                        className="h-8"
                      />
                    </div>
                  </div>
                  <Button onClick={handleCreateStand} className="w-full" size="sm">
                    Create {standRows} × {standCols} Stand
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}

          {onAddHive && (
            <Button variant="outline" size="sm" onClick={onAddHive} title="Add Hive">
              <Hexagon className="h-4 w-4 mr-1" />
              Add Hive
            </Button>
          )}
        </>
      )}

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
