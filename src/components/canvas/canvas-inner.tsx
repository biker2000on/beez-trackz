"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Stage, Layer, Circle, Line, Text as KText } from "react-konva";
import { useRouter } from "next/navigation";
import type Konva from "konva";
import { StandGroup } from "./stand-group";
import { StandContextMenu } from "./stand-context-menu";
import { HiveContextMenu } from "./hive-context-menu";
import { HiveEditModal } from "./hive-edit-modal";
import { NorthArrow } from "./north-arrow";
import { CanvasToolbar } from "./canvas-toolbar";
import { SatelliteOverlay } from "./satellite-overlay";
import { useCanvasViewport } from "./use-canvas-viewport";
import { useStandGeometry } from "./use-stand-geometry";
import {
  StandSettingsDialog,
  DeleteStandDialog,
  FacingDialog,
  MoveToSlotDialog,
  StackChoiceDialog,
  type SlotOption,
} from "./canvas-dialogs";
import {
  saveCanvasLayout,
  createHiveFromCanvas,
  updateHiveFromCanvas,
  assignHiveToSlot,
  setHivePlacement,
  removeHiveFromSlot,
  setHiveFacing,
} from "@/actions/canvas";
import type { CanvasHive, CanvasLayout, StandGeometry } from "@/lib/canvas/types";
import { buildSlotOccupancy, getSlotLabel } from "@/lib/canvas/types";
import {
  CELL_SIZE,
  GRID_SIZE,
  ZOOM_STEP,
  slotAtPoint,
  angleFromPivot,
  standCenter,
  standsBoundingBox,
} from "@/lib/canvas/geometry";

interface CanvasInnerProps {
  apiaryId: string;
  hives: CanvasHive[];
  initialLayout: CanvasLayout | null;
  latitude?: number | null;
  longitude?: number | null;
}

type ContextMenuState =
  | null
  | { type: "stand"; position: { x: number; y: number }; standId: string }
  | { type: "slot"; position: { x: number; y: number }; standId: string; row: number; col: number }
  | { type: "hive"; position: { x: number; y: number }; hiveId: string }
  | { type: "northArrow"; position: { x: number; y: number } };

type DialogState =
  | null
  | { type: "standSettings"; standId: string }
  | { type: "deleteStand"; standId: string }
  | { type: "facing"; hiveId: string }
  | { type: "moveToSlot"; hiveId: string }
  | { type: "stack"; hiveId: string; target: SlotOption }
  | { type: "editHive"; hiveId: string };

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
  latitude,
  longitude,
}: CanvasInnerProps) {
  const router = useRouter();
  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [editMode, setEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [, startTransition] = useTransition();

  // Satellite overlay
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const [satelliteOpacity, setSatelliteOpacity] = useState(0.7);
  const hasSatelliteData = latitude != null && longitude != null;

  // Geometry (stands + north arrow) — explicit Save persists it
  const { stands, northArrow, dirty, dispatch, markSaved } = useStandGeometry({
    stands: initialLayout?.stands ?? [],
    northArrow: initialLayout?.northArrow,
  });

  // Viewport
  const viewport = useCanvasViewport(stageRef, dimensions, initialLayout ?? null);

  // Derived occupancy — the hives table is the source of truth
  const { slotsByStand, unassigned } = useMemo(
    () => buildSlotOccupancy(stands, hives),
    [stands, hives]
  );

  const hiveById = useMemo(() => {
    const map = new Map<string, CanvasHive>();
    hives.forEach((h) => map.set(h.id, h));
    return map;
  }, [hives]);

  const hiveStatusMap = useMemo(() => {
    const map: Record<string, string> = {};
    hives.forEach((h) => (map[h.id] = h.status));
    return map;
  }, [hives]);

  const hiveLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    hives.forEach((h) => (map[h.id] = h.positionLabel));
    return map;
  }, [hives]);

  // Satellite anchor: world point for the apiary lat/lng — fixed at mount
  // so imagery doesn't shift while stands are edited.
  const satelliteAnchor = useMemo(() => {
    const box = standsBoundingBox(initialLayout?.stands ?? []);
    return box
      ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
      : { x: 300, y: 200 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag and rotation interaction state
  const [draggingHiveId, setDraggingHiveId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<{
    standId: string;
    row: number;
    col: number;
    canDrop: boolean;
    willStack: boolean;
  } | null>(null);
  const [rotatingStandId, setRotatingStandId] = useState<string | null>(null);
  const isRotationDragging = useRef(false);

  const rotatingStand = rotatingStandId
    ? stands.find((s) => s.id === rotatingStandId) ?? null
    : null;
  const rotationPivot = rotatingStand ? standCenter(rotatingStand) : null;

  // Overlays
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

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

  // Background grid
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = gridCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    drawGrid(ctx, dimensions.width, dimensions.height, viewport.zoom, viewport.offset.x, viewport.offset.y);
  }, [dimensions, viewport.zoom, viewport.offset]);

  // ------------------------------------------------------------------
  // Hive operations — write through to the database immediately
  // ------------------------------------------------------------------

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  const slotOptionFor = useCallback(
    (stand: StandGeometry, row: number, col: number): SlotOption => ({
      standId: stand.id,
      standLabel: stand.label,
      standCols: stand.cols,
      row,
      col,
      label: getSlotLabel(stand.label, row, col, stand.cols),
    }),
    []
  );

  const emptySlotOptions = useMemo(() => {
    const options: SlotOption[] = [];
    for (const stand of stands) {
      const slots = slotsByStand.get(stand.id) ?? [];
      for (const slot of slots) {
        if (slot.hives.length === 0) {
          options.push(slotOptionFor(stand, slot.row, slot.col));
        }
      }
    }
    return options;
  }, [stands, slotsByStand, slotOptionFor]);

  const moveHive = useCallback(
    async (hiveId: string, target: SlotOption, placement?: "full" | "top" | "bottom" | "left" | "right") => {
      try {
        await assignHiveToSlot({
          hiveId,
          apiaryId,
          standId: target.standId,
          standLabel: target.standLabel,
          slotRow: target.row,
          slotCol: target.col,
          standCols: target.standCols,
          placement: placement ?? "full",
        });
        refresh();
      } catch (error) {
        console.error("Failed to move hive:", error);
      }
    },
    [apiaryId, refresh]
  );

  const handleAddHiveToSlot = useCallback(
    async (standId: string, row: number, col: number) => {
      closeContextMenu();
      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;
      try {
        await createHiveFromCanvas(apiaryId, stand.id, stand.label, row, col, stand.cols);
        refresh();
      } catch (error) {
        console.error("Failed to create hive:", error);
      }
    },
    [stands, apiaryId, refresh, closeContextMenu]
  );

  const handleAddHive = useCallback(() => {
    const first = emptySlotOptions[0];
    if (!first) return;
    void handleAddHiveToSlot(first.standId, first.row, first.col);
  }, [emptySlotOptions, handleAddHiveToSlot]);

  const handleRemoveFromSlot = useCallback(
    async (hiveId: string) => {
      closeContextMenu();
      try {
        await removeHiveFromSlot(hiveId, apiaryId);
        refresh();
      } catch (error) {
        console.error("Failed to remove hive from slot:", error);
      }
    },
    [apiaryId, refresh, closeContextMenu]
  );

  const handleFlipDirection = useCallback(
    async (hiveId: string) => {
      closeContextMenu();
      const current = hiveById.get(hiveId)?.facingDegrees ?? 0;
      try {
        await setHiveFacing(hiveId, apiaryId, current + 180);
        refresh();
      } catch (error) {
        console.error("Failed to flip hive direction:", error);
      }
    },
    [apiaryId, hiveById, refresh, closeContextMenu]
  );

  const handleStackChoice = useCallback(
    async (choice: "top-bottom" | "left-right" | "cancel") => {
      if (dialog?.type !== "stack") return;
      const { hiveId, target } = dialog;
      setDialog(null);
      if (choice === "cancel") return;

      const slots = slotsByStand.get(target.standId);
      const occupant = slots
        ?.find((s) => s.row === target.row && s.col === target.col)
        ?.hives.find((h) => h.hiveId !== hiveId);

      const [existingPlacement, movedPlacement] =
        choice === "top-bottom" ? (["bottom", "top"] as const) : (["left", "right"] as const);

      try {
        if (occupant) await setHivePlacement(occupant.hiveId, existingPlacement);
        await moveHive(hiveId, target, movedPlacement);
      } catch (error) {
        console.error("Failed to stack hives:", error);
      }
    },
    [dialog, slotsByStand, moveHive]
  );

  // ------------------------------------------------------------------
  // Drag and drop
  // ------------------------------------------------------------------

  const handleHiveDragStart = useCallback(
    (hiveId: string) => {
      if (!editMode) return;
      setDraggingHiveId(hiveId);
    },
    [editMode]
  );

  const handleHiveDragMove = useCallback(
    (hiveId: string, worldX: number, worldY: number) => {
      if (!editMode) return;
      for (const stand of stands) {
        const hit = slotAtPoint(stand, worldX, worldY);
        if (!hit) continue;
        const slots = slotsByStand.get(stand.id) ?? [];
        const slot = slots.find((s) => s.row === hit.row && s.col === hit.col);
        if (!slot) continue;
        const others = slot.hives.filter((h) => h.hiveId !== hiveId);
        setDragOverSlot({
          standId: stand.id,
          row: hit.row,
          col: hit.col,
          canDrop: others.length < 2,
          willStack: others.length === 1,
        });
        return;
      }
      setDragOverSlot(null);
    },
    [editMode, stands, slotsByStand]
  );

  const handleHiveDragEnd = useCallback(
    (hiveId: string) => {
      const target = dragOverSlot;
      setDraggingHiveId(null);
      setDragOverSlot(null);
      if (!editMode || !target || !target.canDrop) return;

      const stand = stands.find((s) => s.id === target.standId);
      if (!stand) return;
      const option = slotOptionFor(stand, target.row, target.col);

      // Dropping back on the current slot is a no-op
      const hive = hiveById.get(hiveId);
      if (
        hive &&
        hive.standId === target.standId &&
        hive.slotRow === target.row &&
        hive.slotCol === target.col
      ) {
        return;
      }

      if (target.willStack) {
        setDialog({ type: "stack", hiveId, target: option });
      } else {
        void moveHive(hiveId, option);
      }
    },
    [editMode, dragOverSlot, stands, hiveById, slotOptionFor, moveHive]
  );

  // ------------------------------------------------------------------
  // Geometry operations — local until Save
  // ------------------------------------------------------------------

  const handleAddStand = useCallback(
    (rows: number, cols: number) => {
      if (!editMode) return;
      const centerX = (dimensions.width / 2 - viewport.offset.x) / viewport.zoom;
      const centerY = (dimensions.height / 2 - viewport.offset.y) / viewport.zoom;
      dispatch({
        type: "addStand",
        rows,
        cols,
        x: centerX - (cols * CELL_SIZE) / 2,
        y: centerY - (rows * CELL_SIZE) / 2,
      });
    },
    [editMode, dimensions, viewport.offset, viewport.zoom, dispatch]
  );

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await saveCanvasLayout(apiaryId, {
        stands,
        northArrow,
        zoom: viewport.zoom,
        offsetX: viewport.offset.x,
        offsetY: viewport.offset.y,
      });
      markSaved();
    } finally {
      setIsSaving(false);
    }
  }, [apiaryId, stands, northArrow, viewport.zoom, viewport.offset, markSaved]);

  // Debounced autosave: geometry edits persist ~1s after the last change so
  // a reload can't drop a freshly added stand (hive assignments reference
  // stand ids and write through immediately). The Save button remains as a
  // manual flush.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void handleSaveRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [dirty, stands, northArrow]);

  // ------------------------------------------------------------------
  // Context menu plumbing
  // ------------------------------------------------------------------

  const screenToLocal = useCallback((screenX: number, screenY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: screenX - (rect?.left ?? 0), y: screenY - (rect?.top ?? 0) };
  }, []);

  const handleStandRightClick = useCallback(
    (standId: string, sx: number, sy: number) => {
      if (!editMode) return;
      setContextMenu({ type: "stand", position: screenToLocal(sx, sy), standId });
    },
    [editMode, screenToLocal]
  );

  const handleSlotRightClick = useCallback(
    (standId: string, row: number, col: number, sx: number, sy: number) => {
      if (!editMode) return;
      setContextMenu({ type: "slot", position: screenToLocal(sx, sy), standId, row, col });
    },
    [editMode, screenToLocal]
  );

  const handleHiveRightClick = useCallback(
    (hiveId: string, sx: number, sy: number) => {
      setContextMenu({ type: "hive", position: screenToLocal(sx, sy), hiveId });
    },
    [screenToLocal]
  );

  const handleNorthRightClick = useCallback(
    (sx: number, sy: number) => {
      setContextMenu({ type: "northArrow", position: screenToLocal(sx, sy) });
    },
    [screenToLocal]
  );

  const handleHiveDoubleTap = useCallback(
    (hiveId: string) => router.push(`/hives/${hiveId}`),
    [router]
  );

  // ------------------------------------------------------------------
  // Rotation handle
  // ------------------------------------------------------------------

  const applyRotationFromPointer = useCallback(
    (snap: boolean) => {
      if (!isRotationDragging.current || !rotationPivot || !rotatingStandId) return;
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      const world = {
        x: (pointer.x - stage.x()) / stage.scaleX(),
        y: (pointer.y - stage.y()) / stage.scaleY(),
      };
      let angle = angleFromPivot(rotationPivot, world);
      if (snap) angle = Math.round(angle / 45) * 45;
      dispatch({ type: "rotateStand", standId: rotatingStandId, rotation: Math.round(angle) });
    },
    [rotationPivot, rotatingStandId, dispatch]
  );

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  function renderContextMenu() {
    if (!contextMenu) return null;

    if (contextMenu.type === "northArrow") {
      const rotationOptions = [0, 45, 90, 135, 180, 225, 270, 315];
      return (
        <div
          className="absolute z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[160px]"
          style={{ left: contextMenu.position.x, top: contextMenu.position.y }}
        >
          <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">North Arrow</div>
          <div className="h-px bg-border my-1" />
          {rotationOptions.map((deg) => (
            <button
              key={deg}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${
                Math.round(northArrow.rotation) === deg ? "font-bold text-primary" : ""
              }`}
              onClick={() => {
                dispatch({ type: "rotateNorthArrow", rotation: deg });
                closeContextMenu();
              }}
            >
              {deg}° {deg === 0 ? "(Default)" : ""}
            </button>
          ))}
        </div>
      );
    }

    if (contextMenu.type === "hive") {
      const hive = hiveById.get(contextMenu.hiveId);
      return (
        <HiveContextMenu
          position={contextMenu.position}
          hiveId={contextMenu.hiveId}
          hiveName={hive?.positionLabel ?? "Hive"}
          onClose={closeContextMenu}
          onSetFacing={() => {
            setDialog({ type: "facing", hiveId: contextMenu.hiveId });
            closeContextMenu();
          }}
          onMoveToSlot={() => {
            setDialog({ type: "moveToSlot", hiveId: contextMenu.hiveId });
            closeContextMenu();
          }}
          onRemoveFromSlot={() => void handleRemoveFromSlot(contextMenu.hiveId)}
          onEditHive={() => {
            setDialog({ type: "editHive", hiveId: contextMenu.hiveId });
            closeContextMenu();
          }}
          onFlipDirection={() => void handleFlipDirection(contextMenu.hiveId)}
          onSplitHive={() => {
            closeContextMenu();
            router.push(`/hives/${contextMenu.hiveId}/split`);
          }}
        />
      );
    }

    const stand = stands.find((s) => s.id === contextMenu.standId);
    if (!stand) return null;

    if (contextMenu.type === "slot") {
      const slots = slotsByStand.get(stand.id) ?? [];
      const slot = slots.find((s) => s.row === contextMenu.row && s.col === contextMenu.col);
      const slotLabel = getSlotLabel(stand.label, contextMenu.row, contextMenu.col, stand.cols);
      const slotOccupied = (slot?.hives.length ?? 0) > 0;

      return (
        <StandContextMenu
          position={contextMenu.position}
          standLabel={stand.label}
          slotLabel={slotLabel}
          slotOccupied={slotOccupied}
          isMultiOccupant={(slot?.hives.length ?? 0) > 1}
          onClose={closeContextMenu}
          onRenameStand={() => {
            setDialog({ type: "standSettings", standId: stand.id });
            closeContextMenu();
          }}
          onResizeStand={() => {
            setDialog({ type: "standSettings", standId: stand.id });
            closeContextMenu();
          }}
          onRotateStand={() => {
            setRotatingStandId((prev) => (prev === stand.id ? null : stand.id));
            closeContextMenu();
          }}
          onDeleteStand={() => {
            setDialog({ type: "deleteStand", standId: stand.id });
            closeContextMenu();
          }}
          onAddNewHive={
            !slotOccupied
              ? () => void handleAddHiveToSlot(stand.id, contextMenu.row, contextMenu.col)
              : undefined
          }
          onRemoveHiveFromSlot={
            slotOccupied && slot?.hives[0]
              ? () => void handleRemoveFromSlot(slot.hives[0].hiveId)
              : undefined
          }
        />
      );
    }

    return (
      <StandContextMenu
        position={contextMenu.position}
        standLabel={stand.label}
        onClose={closeContextMenu}
        onRenameStand={() => {
          setDialog({ type: "standSettings", standId: stand.id });
          closeContextMenu();
        }}
        onResizeStand={() => {
          setDialog({ type: "standSettings", standId: stand.id });
          closeContextMenu();
        }}
        onRotateStand={() => {
          setRotatingStandId((prev) => (prev === stand.id ? null : stand.id));
          closeContextMenu();
        }}
        onDeleteStand={() => {
          setDialog({ type: "deleteStand", standId: stand.id });
          closeContextMenu();
        }}
      />
    );
  }

  function renderDialogs() {
    const dialogStand =
      dialog?.type === "standSettings" || dialog?.type === "deleteStand"
        ? stands.find((s) => s.id === dialog.standId) ?? null
        : null;
    const dialogHive =
      dialog?.type === "facing" || dialog?.type === "moveToSlot" || dialog?.type === "editHive"
        ? hiveById.get(dialog.hiveId)
        : undefined;

    return (
      <>
        <StandSettingsDialog
          stand={dialogStand}
          open={dialog?.type === "standSettings"}
          onOpenChange={(o) => !o && setDialog(null)}
          onSave={(standId, label, rows, cols) => {
            dispatch({ type: "renameStand", standId, label });
            dispatch({ type: "resizeStand", standId, rows, cols });
            setDialog(null);
          }}
        />
        <DeleteStandDialog
          stand={dialogStand}
          hasHives={
            dialogStand
              ? (slotsByStand.get(dialogStand.id) ?? []).some((s) => s.hives.length > 0)
              : false
          }
          open={dialog?.type === "deleteStand"}
          onOpenChange={(o) => !o && setDialog(null)}
          onConfirm={(standId) => {
            dispatch({ type: "deleteStand", standId });
            setDialog(null);
          }}
        />
        {dialog?.type === "facing" && dialogHive && (
          <FacingDialog
            hiveName={dialogHive.positionLabel}
            initialDegrees={dialogHive.facingDegrees ?? 0}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            onSave={(degrees) => {
              void setHiveFacing(dialogHive.id, apiaryId, degrees).then(refresh);
              setDialog(null);
            }}
          />
        )}
        {dialog?.type === "moveToSlot" && dialogHive && (
          <MoveToSlotDialog
            hiveName={dialogHive.positionLabel}
            options={emptySlotOptions}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            onMove={(option) => {
              void moveHive(dialogHive.id, option);
              setDialog(null);
            }}
          />
        )}
        <StackChoiceDialog
          open={dialog?.type === "stack"}
          onOpenChange={() => undefined}
          onChoice={(choice) => void handleStackChoice(choice)}
        />
        {dialog?.type === "editHive" && dialogHive && (
          <HiveEditModal
            open
            onOpenChange={(o) => !o && setDialog(null)}
            hiveId={dialogHive.id}
            hiveName={dialogHive.positionLabel}
            hiveStatus={dialogHive.status}
            hiveNotes={dialogHive.notes ?? undefined}
            onSave={async (hiveId, data) => {
              await updateHiveFromCanvas(hiveId, data);
              refresh();
            }}
          />
        )}
      </>
    );
  }

  if (hives.length === 0 && stands.length === 0 && !editMode) {
    // Still render the canvas in edit mode so stands can be laid out first.
  }

  return (
    <div className="relative" ref={containerRef}>
      <div className="absolute top-2 left-2 z-10">
        <CanvasToolbar
          editMode={editMode}
          hasUnsavedChanges={dirty}
          isSaving={isSaving}
          satelliteEnabled={satelliteEnabled}
          satelliteOpacity={satelliteOpacity}
          onToggleEditMode={() => {
            setEditMode((prev) => !prev);
            setRotatingStandId(null);
            closeContextMenu();
          }}
          onZoomIn={() => viewport.zoomBy(ZOOM_STEP * 2)}
          onZoomOut={() => viewport.zoomBy(-ZOOM_STEP * 2)}
          onResetView={() => viewport.fitToContent(stands)}
          onSave={() => void handleSave()}
          onToggleSatellite={hasSatelliteData ? () => setSatelliteEnabled((p) => !p) : undefined}
          onSatelliteOpacityChange={hasSatelliteData ? setSatelliteOpacity : undefined}
          onAddStand={handleAddStand}
          onAddHive={emptySlotOptions.length > 0 ? handleAddHive : undefined}
        />
      </div>

      <div className="relative border rounded-lg overflow-hidden bg-stone-50">
        <canvas
          ref={gridCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: dimensions.width, height: dimensions.height }}
        />

        <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          scaleX={viewport.zoom}
          scaleY={viewport.zoom}
          x={viewport.offset.x}
          y={viewport.offset.y}
          draggable
          onWheel={viewport.handleWheel}
          onDragEnd={viewport.handleStageDragEnd}
          onClick={() => {
            closeContextMenu();
            setRotatingStandId(null);
            isRotationDragging.current = false;
          }}
          onTap={() => {
            closeContextMenu();
            setRotatingStandId(null);
            isRotationDragging.current = false;
          }}
          onMouseMove={(e) => applyRotationFromPointer(e.evt.ctrlKey || e.evt.shiftKey)}
          onMouseUp={() => {
            isRotationDragging.current = false;
          }}
          onTouchMove={(e) => {
            if (isRotationDragging.current) {
              applyRotationFromPointer(false);
              return;
            }
            viewport.handlePinchMove(e);
          }}
          onTouchEnd={() => {
            isRotationDragging.current = false;
            viewport.endPinch();
          }}
        >
          <Layer>
            {satelliteEnabled && hasSatelliteData && latitude != null && longitude != null && (
              <SatelliteOverlay
                latitude={latitude}
                longitude={longitude}
                anchor={satelliteAnchor}
                opacity={satelliteOpacity}
              />
            )}

            <NorthArrow
              x={northArrow.x}
              y={northArrow.y}
              rotation={northArrow.rotation}
              draggable={editMode}
              onDragEnd={(x, y) => dispatch({ type: "moveNorthArrow", x, y })}
              onRotate={(rotation) => dispatch({ type: "rotateNorthArrow", rotation })}
              onRightClick={handleNorthRightClick}
            />

            {stands.map((stand) => (
              <StandGroup
                key={stand.id}
                stand={stand}
                slots={slotsByStand.get(stand.id) ?? []}
                hiveStatusMap={hiveStatusMap}
                hiveLabelMap={hiveLabelMap}
                editMode={editMode}
                isRotating={rotatingStandId === stand.id}
                draggingHiveId={draggingHiveId}
                dragOverSlot={dragOverSlot?.standId === stand.id ? dragOverSlot : null}
                onStandDragEnd={(standId, x, y) => dispatch({ type: "moveStand", standId, x, y })}
                onHiveRightClick={handleHiveRightClick}
                onSlotRightClick={handleSlotRightClick}
                onStandRightClick={handleStandRightClick}
                onHiveDoubleTap={handleHiveDoubleTap}
                onHiveDragStart={handleHiveDragStart}
                onHiveDragMove={handleHiveDragMove}
                onHiveDragEnd={handleHiveDragEnd}
              />
            ))}

            {rotatingStand && rotationPivot && (() => {
              const rad = rotatingStand.rotation * (Math.PI / 180);
              const handleDist =
                (Math.max(rotatingStand.cols, rotatingStand.rows) * CELL_SIZE) / 2 + 50;
              const hx = rotationPivot.x + Math.sin(rad) * handleDist;
              const hy = rotationPivot.y - Math.cos(rad) * handleDist;
              return (
                <>
                  <Line
                    points={[rotationPivot.x, rotationPivot.y, hx, hy]}
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    dash={[4, 4]}
                    listening={false}
                  />
                  <Circle x={rotationPivot.x} y={rotationPivot.y} radius={4} fill="#f59e0b" listening={false} />
                  <Circle
                    x={hx}
                    y={hy}
                    radius={12}
                    fill="#f59e0b"
                    stroke="#b45309"
                    strokeWidth={2}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                      isRotationDragging.current = true;
                    }}
                    onTouchStart={(e) => {
                      e.cancelBubble = true;
                      isRotationDragging.current = true;
                    }}
                    onClick={(e) => {
                      e.cancelBubble = true;
                    }}
                    onTap={(e) => {
                      e.cancelBubble = true;
                    }}
                    onMouseEnter={(e) => {
                      const c = e.target.getStage()?.container();
                      if (c) c.style.cursor = "grab";
                    }}
                    onMouseLeave={(e) => {
                      const c = e.target.getStage()?.container();
                      if (c) c.style.cursor = "default";
                    }}
                  />
                  <KText
                    x={hx - 20}
                    y={hy + 16}
                    width={40}
                    text={`${Math.round(rotatingStand.rotation)}°`}
                    fontSize={11}
                    fontStyle="bold"
                    fill="#b45309"
                    align="center"
                    listening={false}
                  />
                </>
              );
            })()}
          </Layer>
        </Stage>

        {renderContextMenu()}
      </div>

      {/* Unassigned hives — explicit placement instead of silent auto-fill */}
      {unassigned.length > 0 && (
        <div className="mt-2 rounded-md border bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-800 mb-1">
            Unplaced hives — drag stands into place, then assign:
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((hive) => (
              <button
                key={hive.id}
                className="text-xs px-2 py-1 rounded border bg-white hover:bg-accent transition-colors"
                onClick={() => setDialog({ type: "moveToSlot", hiveId: hive.id })}
              >
                {hive.positionLabel} →
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mode indicator */}
      <div className="absolute bottom-2 right-2 z-10">
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            editMode ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-stone-600"
          }`}
        >
          {editMode
            ? rotatingStandId
              ? "Rotate Mode - Drag handle (Ctrl/Shift snaps 45°), click background to finish"
              : "Edit Mode - Hive moves save instantly; stand layout saves with Save"
            : "View Mode - Double-click a hive to open it, right-click for actions"}
        </span>
      </div>

      {renderDialogs()}
    </div>
  );
}
