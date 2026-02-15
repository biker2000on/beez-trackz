"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Stage, Layer, Rect } from "react-konva";
import { useRouter } from "next/navigation";
import type Konva from "konva";
import { HiveIcon } from "./hive-icon";
import { NorthArrow } from "./north-arrow";
import { CanvasToolbar } from "./canvas-toolbar";
import { saveCanvasLayout, type CanvasLayout } from "@/actions/canvas";

const HIVE_WIDTH = 60;
const HIVE_HEIGHT = 50;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const GRID_SIZE = 40;

interface Hive {
  id: string;
  positionLabel: string;
  status: string;
}

interface CanvasInnerProps {
  apiaryId: string;
  hives: Hive[];
  initialLayout: CanvasLayout | null;
}

function autoPlaceHives(
  hives: Hive[],
  existingPositions: Record<string, { x: number; y: number }>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {
    ...existingPositions,
  };
  const unplaced = hives.filter((h) => !positions[h.id]);

  const cols = Math.max(4, Math.ceil(Math.sqrt(unplaced.length)));
  const spacing = 80;

  unplaced.forEach((hive, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    positions[hive.id] = {
      x: 60 + col * spacing,
      y: 60 + row * spacing,
    };
  });

  return positions;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  offsetX: number,
  offsetY: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 0.5;

  const gridSize = GRID_SIZE * zoom;
  const startX = (offsetX % gridSize) - gridSize;
  const startY = (offsetY % gridSize) - gridSize;

  for (let x = startX; x < width + gridSize; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = startY; y < height + gridSize; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

export function CanvasInner({
  apiaryId,
  hives,
  initialLayout,
}: CanvasInnerProps) {
  const router = useRouter();
  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [editMode, setEditMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Canvas state
  const [zoom, setZoom] = useState(initialLayout?.zoom ?? 1);
  const [offset, setOffset] = useState({
    x: initialLayout?.offsetX ?? 0,
    y: initialLayout?.offsetY ?? 0,
  });
  const [hivePositions, setHivePositions] = useState<
    Record<string, { x: number; y: number }>
  >(() => autoPlaceHives(hives, initialLayout?.hives ?? {}));
  const [northArrow, setNorthArrow] = useState(
    initialLayout?.northArrow ?? { x: 40, y: 40, rotation: 0 }
  );

  // Responsive sizing
  useEffect(() => {
    function updateSize() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({
          width: Math.floor(rect.width),
          height: Math.max(400, Math.floor(window.innerHeight - rect.top - 40)),
        });
      }
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Handle hive drag end
  const handleHiveDragEnd = useCallback(
    (id: string, x: number, y: number) => {
      if (!editMode) return;
      setHivePositions((prev) => ({
        ...prev,
        [id]: { x, y },
      }));
      setHasUnsavedChanges(true);
    },
    [editMode]
  );

  // Handle hive double-tap (navigate)
  const handleHiveDoubleTap = useCallback(
    (id: string) => {
      router.push(`/hives/${id}`);
    },
    [router]
  );

  // North arrow handlers
  const handleNorthDragEnd = useCallback(
    (x: number, y: number) => {
      if (!editMode) return;
      setNorthArrow((prev) => ({ ...prev, x, y }));
      setHasUnsavedChanges(true);
    },
    [editMode]
  );

  const handleNorthRotate = useCallback(
    (rotation: number) => {
      if (!editMode) return;
      setNorthArrow((prev) => ({ ...prev, rotation }));
      setHasUnsavedChanges(true);
    },
    [editMode]
  );

  // Wheel zoom
  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;

      const oldScale = zoom;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const direction = e.evt.deltaY < 0 ? 1 : -1;
      const newScale = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, oldScale + direction * ZOOM_STEP)
      );

      const mousePointTo = {
        x: (pointer.x - offset.x) / oldScale,
        y: (pointer.y - offset.y) / oldScale,
      };

      setZoom(newScale);
      setOffset({
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      });
    },
    [zoom, offset]
  );

  // Stage drag (pan)
  const handleStageDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      if (e.target !== stageRef.current) return;
      setOffset({
        x: e.target.x(),
        y: e.target.y(),
      });
    },
    []
  );

  // Toolbar actions
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(MAX_ZOOM, prev + ZOOM_STEP * 2));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(MIN_ZOOM, prev - ZOOM_STEP * 2));
  }, []);

  const handleResetView = useCallback(() => {
    if (hives.length === 0) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }

    const positions = Object.values(hivePositions);
    if (positions.length === 0) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }

    const minX = Math.min(...positions.map((p) => p.x));
    const maxX = Math.max(...positions.map((p) => p.x)) + HIVE_WIDTH;
    const minY = Math.min(...positions.map((p) => p.y));
    const maxY = Math.max(...positions.map((p) => p.y)) + HIVE_HEIGHT;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    const padding = 80;
    const scaleX = (dimensions.width - padding * 2) / contentWidth;
    const scaleY = (dimensions.height - padding * 2) / contentHeight;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

    setZoom(newZoom);
    setOffset({
      x: (dimensions.width - contentWidth * newZoom) / 2 - minX * newZoom,
      y: (dimensions.height - contentHeight * newZoom) / 2 - minY * newZoom,
    });
  }, [hives.length, hivePositions, dimensions]);

  const handleToggleEditMode = useCallback(() => {
    setEditMode((prev) => !prev);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const layout: CanvasLayout = {
        hives: hivePositions,
        northArrow,
        zoom,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      await saveCanvasLayout(apiaryId, layout);
      setHasUnsavedChanges(false);
    } finally {
      setIsSaving(false);
    }
  }, [apiaryId, hivePositions, northArrow, zoom, offset]);

  // Draw grid on a background canvas
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    drawGrid(ctx, dimensions.width, dimensions.height, zoom, offset.x, offset.y);
  }, [dimensions, zoom, offset]);

  return (
    <div className="relative" ref={containerRef}>
      <div className="absolute top-2 left-2 z-10">
        <CanvasToolbar
          editMode={editMode}
          hasUnsavedChanges={hasUnsavedChanges}
          isSaving={isSaving}
          onToggleEditMode={handleToggleEditMode}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetView={handleResetView}
          onSave={handleSave}
        />
      </div>

      <div className="relative border rounded-lg overflow-hidden bg-stone-50">
        {/* Grid background */}
        <canvas
          ref={gridCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: dimensions.width, height: dimensions.height }}
        />

        <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          scaleX={zoom}
          scaleY={zoom}
          x={offset.x}
          y={offset.y}
          draggable
          onWheel={handleWheel}
          onDragEnd={handleStageDragEnd}
          onTouchMove={(e) => {
            // Pinch zoom support
            const touch1 = e.evt.touches[0];
            const touch2 = e.evt.touches[1];
            if (!touch1 || !touch2) return;

            e.evt.preventDefault();
            const dist = Math.sqrt(
              (touch2.clientX - touch1.clientX) ** 2 +
                (touch2.clientY - touch1.clientY) ** 2
            );

            const stage = stageRef.current;
            if (!stage) return;

            const lastDist = (stage as unknown as { _lastDist?: number })
              ._lastDist;
            if (lastDist) {
              const scale = zoom * (dist / lastDist);
              setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale)));
            }
            (stage as unknown as { _lastDist: number })._lastDist = dist;
          }}
          onTouchEnd={() => {
            const stage = stageRef.current;
            if (stage) {
              (stage as unknown as { _lastDist: number | undefined })._lastDist =
                undefined;
            }
          }}
        >
          <Layer>
            {/* Transparent background rect to capture drag events */}
            <Rect
              width={dimensions.width * 4}
              height={dimensions.height * 4}
              x={-dimensions.width * 2}
              y={-dimensions.height * 2}
              fill="transparent"
              listening={false}
            />

            {/* North arrow */}
            <NorthArrow
              x={northArrow.x}
              y={northArrow.y}
              rotation={northArrow.rotation}
              draggable={editMode}
              onDragEnd={handleNorthDragEnd}
              onRotate={handleNorthRotate}
            />

            {/* Hive icons */}
            {hives.map((hive) => {
              const pos = hivePositions[hive.id] || { x: 0, y: 0 };
              return (
                <HiveIcon
                  key={hive.id}
                  id={hive.id}
                  positionLabel={hive.positionLabel}
                  status={hive.status}
                  x={pos.x}
                  y={pos.y}
                  draggable={editMode}
                  onDragEnd={handleHiveDragEnd}
                  onDoubleTap={handleHiveDoubleTap}
                />
              );
            })}
          </Layer>
        </Stage>
      </div>

      {/* Mode indicator */}
      <div className="absolute bottom-2 right-2 z-10">
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            editMode
              ? "bg-amber-100 text-amber-800"
              : "bg-stone-100 text-stone-600"
          }`}
        >
          {editMode
            ? "Edit Mode - Drag to reposition"
            : "View Mode - Double-click to open hive"}
        </span>
      </div>
    </div>
  );
}
