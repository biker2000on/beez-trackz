"use client";

import { useState } from "react";
import {
  Grid3x3,
  Hexagon,
  Lock,
  MapPin,
  Maximize,
  Save,
  Sun,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { TILE_LAYERS, type TileLayerId } from "@/features/map/tile-layers";

import { STAND_MAX_DIM, STAND_MIN_DIM } from "../lib/types";

export type SaveState = "saved" | "dirty" | "saving";

interface CanvasToolbarProps {
  editMode: boolean;
  saveState: SaveState;
  hasLocation: boolean;
  tileLayer: TileLayerId;
  imageryOpacity: number;
  sunEnabled: boolean;
  addHiveEnabled: boolean;
  onToggleEditMode: () => void;
  onAddStand: (rows: number, cols: number) => void;
  onAddHive: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitAll: () => void;
  onSave: () => void;
  onTileLayerChange: (id: TileLayerId) => void;
  onImageryOpacityChange: (opacity: number) => void;
  onToggleSun: () => void;
  onSetLocation: () => void;
}

const clampDim = (raw: string) =>
  Math.min(STAND_MAX_DIM, Math.max(STAND_MIN_DIM, parseInt(raw, 10) || STAND_MIN_DIM));

export function CanvasToolbar({
  editMode,
  saveState,
  hasLocation,
  tileLayer,
  imageryOpacity,
  sunEnabled,
  addHiveEnabled,
  onToggleEditMode,
  onAddStand,
  onAddHive,
  onZoomIn,
  onZoomOut,
  onFitAll,
  onSave,
  onTileLayerChange,
  onImageryOpacityChange,
  onToggleSun,
  onSetLocation,
}: CanvasToolbarProps) {
  const [standRows, setStandRows] = useState(2);
  const [standCols, setStandCols] = useState(2);
  const [standPopoverOpen, setStandPopoverOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm">
        <Button
          variant={editMode ? "default" : "outline"}
          size="sm"
          onClick={onToggleEditMode}
          title={editMode ? "Switch to view mode" : "Switch to edit mode"}
        >
          {editMode ? <Unlock /> : <Lock />}
          {editMode ? "Edit" : "View"}
        </Button>

        {editMode && (
          <>
            <div className="h-6 w-px bg-border" />

            <Popover open={standPopoverOpen} onOpenChange={setStandPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" title="Add stand">
                  <Grid3x3 />
                  Add Stand
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h4 className="text-sm font-medium">Create stand</h4>
                    <p className="text-xs text-muted-foreground">
                      Choose the slot grid for the new stand.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="canvas-stand-rows" className="text-xs">
                        Rows
                      </Label>
                      <Input
                        id="canvas-stand-rows"
                        type="number"
                        min={STAND_MIN_DIM}
                        max={STAND_MAX_DIM}
                        value={standRows}
                        onChange={(e) => setStandRows(clampDim(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="canvas-stand-cols" className="text-xs">
                        Columns
                      </Label>
                      <Input
                        id="canvas-stand-cols"
                        type="number"
                        min={STAND_MIN_DIM}
                        max={STAND_MAX_DIM}
                        value={standCols}
                        onChange={(e) => setStandCols(clampDim(e.target.value))}
                        className="h-8"
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      onAddStand(standRows, standCols);
                      setStandPopoverOpen(false);
                    }}
                  >
                    Create {standRows} × {standCols} stand
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            <Button
              variant="outline"
              size="sm"
              onClick={onAddHive}
              disabled={!addHiveEnabled}
              title={
                addHiveEnabled
                  ? "Add a hive to the first empty slot"
                  : "No empty slots — add or resize a stand first"
              }
            >
              <Hexagon />
              Add Hive
            </Button>
          </>
        )}

        <div className="h-6 w-px bg-border" />

        <Button variant="outline" size="icon-sm" onClick={onZoomIn} title="Zoom in">
          <ZoomIn />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={onZoomOut} title="Zoom out">
          <ZoomOut />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={onFitAll} title="Fit all stands">
          <Maximize />
        </Button>

        <div className="h-6 w-px bg-border" />

        <Button
          variant={saveState === "dirty" ? "default" : "outline"}
          size="sm"
          onClick={onSave}
          disabled={saveState !== "dirty"}
          title="Save layout"
        >
          <Save />
          {saveState === "saving"
            ? "Saving…"
            : saveState === "dirty"
              ? "Save"
              : "Saved"}
        </Button>

        <div className="h-6 w-px bg-border" />

        <Button
          variant="outline"
          size="sm"
          onClick={onSetLocation}
          title="Set yard location"
        >
          <MapPin />
          {hasLocation ? "Location" : "Set location"}
        </Button>

        {hasLocation && (
          <Button
            variant={sunEnabled ? "default" : "outline"}
            size="sm"
            onClick={onToggleSun}
            title="Sunrise and sunset overlay"
          >
            <Sun />
            Sun
          </Button>
        )}
      </div>

      {hasLocation && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm">
          {(Object.keys(TILE_LAYERS) as TileLayerId[]).map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={tileLayer === id ? "default" : "outline"}
              onClick={() => onTileLayerChange(id)}
            >
              {TILE_LAYERS[id].label}
            </Button>
          ))}
          {tileLayer === "imagery" && (
            <>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Opacity:
              </span>
              <Slider
                value={[Math.round(imageryOpacity * 100)]}
                onValueChange={(values) => onImageryOpacityChange(values[0] / 100)}
                min={20}
                max={100}
                step={5}
                className="w-28"
              />
              <span className="w-8 text-xs text-muted-foreground">
                {Math.round(imageryOpacity * 100)}%
              </span>
            </>
          )}
          <span className="text-[11px] text-muted-foreground">
            Coords sent to {TILE_LAYERS[tileLayer].seenBy}
          </span>
        </div>
      )}

    </div>
  );
}
