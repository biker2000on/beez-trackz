"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type Konva from "konva";
import { Layer, Stage, Text as KonvaText } from "react-konva";
import { toast } from "sonner";

import {
  angleFromPivot,
  CELL_SIZE,
  GRID_SIZE,
  slotAtPoint,
  standCenter,
  ZOOM_STEP,
} from "./lib/geometry";
import {
  buildSlotOccupancy,
  getSlotLabel,
  type CanvasHive,
  type CanvasLayout,
  type HivePlacement,
  type SlotTarget,
  type StandGeometry,
} from "./lib/types";
import { useCanvasApi, type ApiaryDetail } from "./lib/use-canvas-data";
import { useLayoutState } from "./lib/use-layout-state";
import { measureCanvasSurface } from "./lib/sizing";
import { useViewport } from "./lib/use-viewport";
import { NorthArrow } from "./stage/north-arrow";
import { RotationGizmo } from "./stage/rotation-gizmo";
import { SatelliteLayer } from "./stage/satellite-layer";
import { StandGroup, type DragOverSlot } from "./stage/stand-group";
import {
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSurface,
} from "./ui/context-menu";
import {
  AssignHiveDialog,
  DeleteStandDialog,
  FacingDialog,
  HiveEditDialog,
  MoveToSlotDialog,
  StackChoiceDialog,
  StandSettingsDialog,
} from "./ui/dialogs";
import { CanvasToolbar, type SaveState } from "./ui/toolbar";

const NORTH_PRESETS = [0, 45, 90, 135, 180, 225, 270, 315];

type ContextMenuState =
  | { type: "stand"; position: { x: number; y: number }; standId: string }
  | {
      type: "slot";
      position: { x: number; y: number };
      standId: string;
      row: number;
      col: number;
    }
  | { type: "hive"; position: { x: number; y: number }; hiveId: string }
  | { type: "north"; position: { x: number; y: number } }
  | null;

type DialogState =
  | { type: "standSettings"; standId: string }
  | { type: "deleteStand"; standId: string }
  | { type: "facing"; hiveId: string }
  | { type: "moveToSlot"; hiveId: string }
  | { type: "assignHive"; target: SlotTarget }
  | { type: "stack"; hiveId: string; target: SlotTarget }
  | { type: "editHive"; hiveId: string }
  | null;

type RotationTarget = { kind: "stand"; standId: string } | { kind: "north" };

function drawGrid(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(128, 128, 128, 0.18)";
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

interface CanvasInnerProps {
  apiary: ApiaryDetail;
  hives: CanvasHive[];
  initialLayout: CanvasLayout;
}

export function CanvasInner({ apiary, hives, initialLayout }: CanvasInnerProps) {
  const apiaryId = apiary.id;
  const router = useRouter();
  const canvasApi = useCanvasApi(apiaryId);

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);

  // Satellite overlay
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const [satelliteOpacity, setSatelliteOpacity] = useState(0.7);
  const satelliteAvailable =
    apiary.latitude != null && apiary.longitude != null;

  // Geometry — local reducer state, persisted via Save / autosave
  const { stands, northArrow, dirty, dispatch, markSaved } = useLayoutState({
    stands: initialLayout.stands ?? [],
    northArrow: initialLayout.northArrow,
  });

  // Viewport
  const viewport = useViewport(stageRef, dimensions, initialLayout);

  // Derived occupancy — the hives table is the source of truth
  const { slotsByStand, unassigned } = useMemo(
    () => buildSlotOccupancy(stands, hives),
    [stands, hives],
  );

  const hiveById = useMemo(() => {
    const map = new Map<string, CanvasHive>();
    for (const hive of hives) map.set(hive.id, hive);
    return map;
  }, [hives]);

  const hiveStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const hive of hives) map.set(hive.id, hive.status);
    return map;
  }, [hives]);

  const hiveLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const hive of hives) map.set(hive.id, hive.positionLabel);
    return map;
  }, [hives]);

  // Satellite anchor: the world point for the apiary lat/lng, fixed at
  // mount so imagery doesn't shift underneath while stands are edited.
  const [satelliteAnchor] = useState(() => {
    const initialStands = initialLayout.stands ?? [];
    if (initialStands.length === 0) return { x: 300, y: 200 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stand of initialStands) {
      minX = Math.min(minX, stand.x);
      minY = Math.min(minY, stand.y);
      maxX = Math.max(maxX, stand.x + stand.cols * CELL_SIZE);
      maxY = Math.max(maxY, stand.y + stand.rows * CELL_SIZE);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  });

  // Interaction state
  const [draggingHiveId, setDraggingHiveId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<DragOverSlot | null>(null);
  const [rotatingStandId, setRotatingStandId] = useState<string | null>(null);
  const rotationDrag = useRef<RotationTarget | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const rotatingStand = rotatingStandId
    ? (stands.find((s) => s.id === rotatingStandId) ?? null)
    : null;

  // ------------------------------------------------------------------
  // Sizing + background grid
  // ------------------------------------------------------------------

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const updateSize = () => {
      setDimensions(measureCanvasSurface(surface, window.innerHeight));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(surface);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    drawGrid(
      canvas,
      dimensions.width,
      dimensions.height,
      viewport.zoom,
      viewport.offset.x,
      viewport.offset.y,
    );
  }, [dimensions, viewport.zoom, viewport.offset]);

  // ------------------------------------------------------------------
  // Layout persistence: explicit Save + 1s debounced autosave
  // ------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await canvasApi.saveLayout({
        stands,
        northArrow,
        zoom: viewport.zoom,
        offsetX: viewport.offset.x,
        offsetY: viewport.offset.y,
      });
      markSaved();
    } catch {
      toast.error("Could not save the layout. Your changes are still local.");
    } finally {
      setSaving(false);
    }
  }, [canvasApi, stands, northArrow, viewport.zoom, viewport.offset, markSaved]);

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void handleSaveRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [dirty, stands, northArrow]);

  const saveState: SaveState = saving ? "saving" : dirty ? "dirty" : "saved";

  // ------------------------------------------------------------------
  // Slot helpers
  // ------------------------------------------------------------------

  const slotTargetFor = useCallback(
    (stand: StandGeometry, row: number, col: number): SlotTarget => ({
      standId: stand.id,
      standLabel: stand.label,
      standCols: stand.cols,
      row,
      col,
      label: getSlotLabel(stand.label, row, col, stand.cols),
    }),
    [],
  );

  const emptySlotTargets = useMemo(() => {
    const targets: SlotTarget[] = [];
    for (const stand of stands) {
      const slots = slotsByStand.get(stand.id) ?? [];
      for (const slot of slots) {
        if (slot.hives.length === 0) {
          targets.push(slotTargetFor(stand, slot.row, slot.col));
        }
      }
    }
    return targets;
  }, [stands, slotsByStand, slotTargetFor]);

  // ------------------------------------------------------------------
  // Occupancy operations — write through immediately
  // ------------------------------------------------------------------

  const moveHive = useCallback(
    (hiveId: string, target: SlotTarget, placement: HivePlacement = "full") =>
      canvasApi.assignSlot(hiveId, target, placement),
    [canvasApi],
  );

  const handleAddHiveToSlot = useCallback(
    (target: SlotTarget) => void canvasApi.createHiveInSlot(target),
    [canvasApi],
  );

  const handleAddHive = useCallback(() => {
    const first = emptySlotTargets[0];
    if (first) handleAddHiveToSlot(first);
  }, [emptySlotTargets, handleAddHiveToSlot]);

  const handleFlipDirection = useCallback(
    (hiveId: string) => {
      const current = hiveById.get(hiveId)?.facingDegrees ?? 0;
      void canvasApi.setFacing(hiveId, current + 180);
    },
    [canvasApi, hiveById],
  );

  const handleStackChoice = useCallback(
    (choice: "top-bottom" | "left-right" | "cancel") => {
      if (dialog?.type !== "stack") return;
      const { hiveId, target } = dialog;
      setDialog(null);
      if (choice === "cancel") return;

      const occupant = slotsByStand
        .get(target.standId)
        ?.find((s) => s.row === target.row && s.col === target.col)
        ?.hives.find((h) => h.hiveId !== hiveId);

      const [existingPlacement, movedPlacement]: [HivePlacement, HivePlacement] =
        choice === "top-bottom" ? ["bottom", "top"] : ["left", "right"];

      void (async () => {
        if (occupant && occupant.placement !== existingPlacement) {
          await canvasApi.setPlacement(occupant.hiveId, existingPlacement);
        }
        await moveHive(hiveId, target, movedPlacement);
      })();
    },
    [dialog, slotsByStand, canvasApi, moveHive],
  );

  // ------------------------------------------------------------------
  // Hive drag and drop
  // ------------------------------------------------------------------

  const handleHiveDragStart = useCallback(
    (hiveId: string) => {
      if (!editMode) return;
      setDraggingHiveId(hiveId);
      closeContextMenu();
    },
    [editMode, closeContextMenu],
  );

  const handleHiveDragMove = useCallback(
    (hiveId: string, worldX: number, worldY: number) => {
      if (!editMode) return;
      for (const stand of stands) {
        const hit = slotAtPoint(stand, worldX, worldY);
        if (!hit) continue;
        const slot = slotsByStand
          .get(stand.id)
          ?.find((s) => s.row === hit.row && s.col === hit.col);
        if (!slot) continue;
        const others = slot.hives.filter((h) => h.hiveId !== hiveId);
        const next: DragOverSlot = {
          standId: stand.id,
          row: hit.row,
          col: hit.col,
          canDrop: others.length < 2,
          willStack: others.length === 1,
        };
        setDragOverSlot((prev) =>
          prev &&
          prev.standId === next.standId &&
          prev.row === next.row &&
          prev.col === next.col &&
          prev.canDrop === next.canDrop &&
          prev.willStack === next.willStack
            ? prev
            : next,
        );
        return;
      }
      setDragOverSlot((prev) => (prev === null ? prev : null));
    },
    [editMode, stands, slotsByStand],
  );

  const handleHiveDragEnd = useCallback(
    (hiveId: string) => {
      const target = dragOverSlot;
      setDraggingHiveId(null);
      setDragOverSlot(null);
      if (!editMode || !target || !target.canDrop) return;

      const stand = stands.find((s) => s.id === target.standId);
      if (!stand) return;

      // Dropping back on the current slot is a no-op.
      const hive = hiveById.get(hiveId);
      if (
        hive &&
        hive.standId === target.standId &&
        hive.slotRow === target.row &&
        hive.slotCol === target.col
      ) {
        return;
      }

      const slotTarget = slotTargetFor(stand, target.row, target.col);
      if (target.willStack) {
        setDialog({ type: "stack", hiveId, target: slotTarget });
      } else {
        void moveHive(hiveId, slotTarget);
      }
    },
    [editMode, dragOverSlot, stands, hiveById, slotTargetFor, moveHive],
  );

  // ------------------------------------------------------------------
  // Rotation (stands + north arrow)
  // ------------------------------------------------------------------

  const applyRotationFromPointer = useCallback(
    (snap: boolean) => {
      const target = rotationDrag.current;
      if (!target) return;
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      const world = {
        x: (pointer.x - stage.x()) / stage.scaleX(),
        y: (pointer.y - stage.y()) / stage.scaleY(),
      };

      if (target.kind === "stand") {
        const stand = stands.find((s) => s.id === target.standId);
        if (!stand) return;
        let angle = angleFromPivot(standCenter(stand), world);
        if (snap) angle = Math.round(angle / 45) * 45;
        dispatch({
          type: "rotateStand",
          standId: target.standId,
          rotation: Math.round(angle) % 360,
        });
      } else {
        let angle = angleFromPivot({ x: northArrow.x, y: northArrow.y }, world);
        if (snap) angle = Math.round(angle / 45) * 45;
        dispatch({ type: "rotateNorthArrow", rotation: Math.round(angle) % 360 });
      }
    },
    [stands, northArrow.x, northArrow.y, dispatch],
  );

  const endRotationDrag = useCallback(() => {
    rotationDrag.current = null;
  }, []);

  // Escape leaves rotate mode / closes the context menu.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setRotatingStandId(null);
      rotationDrag.current = null;
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ------------------------------------------------------------------
  // Context menu plumbing (screen → container-local coordinates)
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
    [editMode, screenToLocal],
  );

  const handleSlotRightClick = useCallback(
    (standId: string, row: number, col: number, sx: number, sy: number) => {
      if (!editMode) return;
      setContextMenu({
        type: "slot",
        position: screenToLocal(sx, sy),
        standId,
        row,
        col,
      });
    },
    [editMode, screenToLocal],
  );

  const handleHiveRightClick = useCallback(
    (hiveId: string, sx: number, sy: number) => {
      setContextMenu({ type: "hive", position: screenToLocal(sx, sy), hiveId });
    },
    [screenToLocal],
  );

  const handleNorthRightClick = useCallback(
    (sx: number, sy: number) => {
      setContextMenu({ type: "north", position: screenToLocal(sx, sy) });
    },
    [screenToLocal],
  );

  const openHive = useCallback(
    (hiveId: string) => router.push(`/hives/${hiveId}`),
    [router],
  );

  // ------------------------------------------------------------------
  // Toolbar actions
  // ------------------------------------------------------------------

  const handleAddStand = useCallback(
    (rows: number, cols: number) => {
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
    [dimensions, viewport.offset, viewport.zoom, dispatch],
  );

  // ------------------------------------------------------------------
  // Context menus
  // ------------------------------------------------------------------

  function renderStandMenuItems(stand: StandGeometry) {
    return (
      <>
        <MenuItem
          onClick={() => {
            setDialog({ type: "standSettings", standId: stand.id });
            closeContextMenu();
          }}
        >
          Rename / Resize…
        </MenuItem>
        <MenuItem
          onClick={() => {
            setRotatingStandId((prev) => (prev === stand.id ? null : stand.id));
            closeContextMenu();
          }}
        >
          {rotatingStandId === stand.id ? "Finish rotating" : "Rotate"}
        </MenuItem>
        <MenuItem
          destructive
          onClick={() => {
            setDialog({ type: "deleteStand", standId: stand.id });
            closeContextMenu();
          }}
        >
          Delete stand…
        </MenuItem>
      </>
    );
  }

  function renderContextMenu() {
    if (!contextMenu) return null;

    if (contextMenu.type === "north") {
      return (
        <MenuSurface position={contextMenu.position} onClose={closeContextMenu}>
          <MenuHeading>North arrow</MenuHeading>
          <MenuSeparator />
          {NORTH_PRESETS.map((deg) => (
            <MenuItem
              key={deg}
              onClick={() => {
                dispatch({ type: "rotateNorthArrow", rotation: deg });
                closeContextMenu();
              }}
            >
              <span
                className={
                  Math.round(northArrow.rotation) % 360 === deg
                    ? "font-bold text-primary"
                    : undefined
                }
              >
                {deg}°{deg === 0 ? " (default)" : ""}
              </span>
            </MenuItem>
          ))}
        </MenuSurface>
      );
    }

    if (contextMenu.type === "hive") {
      const hive = hiveById.get(contextMenu.hiveId);
      if (!hive) return null;
      return (
        <MenuSurface position={contextMenu.position} onClose={closeContextMenu}>
          <MenuHeading>{hive.positionLabel}</MenuHeading>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              closeContextMenu();
              openHive(hive.id);
            }}
          >
            View Hive
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeContextMenu();
              openHive(hive.id);
            }}
          >
            New Inspection
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeContextMenu();
              openHive(hive.id);
            }}
          >
            Feed
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeContextMenu();
              openHive(hive.id);
            }}
          >
            Photo
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              setDialog({ type: "editHive", hiveId: hive.id });
              closeContextMenu();
            }}
          >
            Edit Hive…
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDialog({ type: "facing", hiveId: hive.id });
              closeContextMenu();
            }}
          >
            Set Facing…
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeContextMenu();
              handleFlipDirection(hive.id);
            }}
          >
            Flip Direction (+180°)
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDialog({ type: "moveToSlot", hiveId: hive.id });
              closeContextMenu();
            }}
          >
            Move to Slot…
          </MenuItem>
          <MenuItem
            destructive
            onClick={() => {
              closeContextMenu();
              void canvasApi.removeFromSlot(hive.id);
            }}
          >
            Remove from Slot
          </MenuItem>
        </MenuSurface>
      );
    }

    const stand = stands.find((s) => s.id === contextMenu.standId);
    if (!stand) return null;

    if (contextMenu.type === "slot") {
      const { row, col } = contextMenu;
      const slot = slotsByStand
        .get(stand.id)
        ?.find((s) => s.row === row && s.col === col);
      const slotLabel = getSlotLabel(stand.label, row, col, stand.cols);
      const occupants = slot?.hives ?? [];

      return (
        <MenuSurface position={contextMenu.position} onClose={closeContextMenu}>
          <MenuHeading>
            Slot {slotLabel} · Stand {stand.label}
          </MenuHeading>
          <MenuSeparator />
          {occupants.length === 0 ? (
            <>
              <MenuItem
                onClick={() => {
                  closeContextMenu();
                  handleAddHiveToSlot(slotTargetFor(stand, row, col));
                }}
              >
                Add New Hive
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setDialog({
                    type: "assignHive",
                    target: slotTargetFor(stand, row, col),
                  });
                  closeContextMenu();
                }}
              >
                Assign Existing Hive…
              </MenuItem>
            </>
          ) : (
            occupants.map((occupant) => (
              <MenuItem
                key={occupant.hiveId}
                destructive
                onClick={() => {
                  closeContextMenu();
                  void canvasApi.removeFromSlot(occupant.hiveId);
                }}
              >
                Remove {hiveLabelById.get(occupant.hiveId) ?? "hive"} from Slot
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          {renderStandMenuItems(stand)}
        </MenuSurface>
      );
    }

    return (
      <MenuSurface position={contextMenu.position} onClose={closeContextMenu}>
        <MenuHeading>Stand {stand.label}</MenuHeading>
        <MenuSeparator />
        {renderStandMenuItems(stand)}
      </MenuSurface>
    );
  }

  // ------------------------------------------------------------------
  // Dialogs
  // ------------------------------------------------------------------

  function renderDialog() {
    if (!dialog) return null;

    if (dialog.type === "standSettings" || dialog.type === "deleteStand") {
      const stand = stands.find((s) => s.id === dialog.standId);
      if (!stand) return null;
      if (dialog.type === "standSettings") {
        return (
          <StandSettingsDialog
            key={stand.id}
            stand={stand}
            onOpenChange={(open) => !open && closeDialog()}
            onSave={(label, rows, cols) => {
              dispatch({ type: "configureStand", standId: stand.id, label, rows, cols });
              closeDialog();
            }}
          />
        );
      }
      const hasHives = (slotsByStand.get(stand.id) ?? []).some(
        (s) => s.hives.length > 0,
      );
      return (
        <DeleteStandDialog
          stand={stand}
          hasHives={hasHives}
          onOpenChange={(open) => !open && closeDialog()}
          onConfirm={() => {
            dispatch({ type: "deleteStand", standId: stand.id });
            if (rotatingStandId === stand.id) setRotatingStandId(null);
            closeDialog();
          }}
        />
      );
    }

    if (dialog.type === "stack") {
      return <StackChoiceDialog onChoice={handleStackChoice} />;
    }

    if (dialog.type === "assignHive") {
      const candidates = hives
        .filter(
          (h) =>
            !(
              h.standId === dialog.target.standId &&
              h.slotRow === dialog.target.row &&
              h.slotCol === dialog.target.col
            ),
        )
        .map((h) => ({
          ...h,
          assigned: h.standId != null && slotsByStand.has(h.standId),
        }))
        .sort((a, b) => Number(a.assigned) - Number(b.assigned));
      return (
        <AssignHiveDialog
          key={`${dialog.target.standId}:${dialog.target.row}:${dialog.target.col}`}
          slotLabel={dialog.target.label}
          hives={candidates}
          onOpenChange={(open) => !open && closeDialog()}
          onAssign={(hiveId) => {
            closeDialog();
            void moveHive(hiveId, dialog.target);
          }}
        />
      );
    }

    const hive = hiveById.get(dialog.hiveId);
    if (!hive) return null;

    switch (dialog.type) {
      case "facing":
        return (
          <FacingDialog
            key={hive.id}
            hiveName={hive.positionLabel}
            initialDegrees={hive.facingDegrees ?? 0}
            onOpenChange={(open) => !open && closeDialog()}
            onSave={(degrees) => {
              closeDialog();
              void canvasApi.setFacing(hive.id, degrees);
            }}
          />
        );
      case "moveToSlot":
        return (
          <MoveToSlotDialog
            key={hive.id}
            hiveName={hive.positionLabel}
            options={emptySlotTargets}
            onOpenChange={(open) => !open && closeDialog()}
            onMove={(target) => {
              closeDialog();
              void moveHive(hive.id, target);
            }}
          />
        );
      case "editHive":
        return (
          <HiveEditDialog
            key={hive.id}
            hive={hive}
            onOpenChange={(open) => !open && closeDialog()}
            onSave={async (data) => {
              const ok = await canvasApi.updateHive(hive.id, data);
              if (ok) closeDialog();
            }}
          />
        );
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const mode = draggingHiveId
    ? "dragging"
    : rotatingStandId
      ? "rotating"
      : editMode
        ? "edit"
        : "view";

  const modeText = {
    view: "View mode — double-click a hive to open it, right-click for actions",
    edit: "Edit mode — hive moves save instantly; stand layout saves with Save",
    rotating: "Rotate mode — drag the handle (Ctrl/Shift snaps 45°), click the background to finish",
    dragging: "Drop the hive on a highlighted slot",
  }[mode];

  return (
    <div
      ref={containerRef}
      className="relative w-full min-w-0 max-w-full"
    >
      <div className="absolute left-2 top-2 z-10">
        <CanvasToolbar
          editMode={editMode}
          saveState={saveState}
          satelliteAvailable={satelliteAvailable}
          satelliteEnabled={satelliteEnabled}
          satelliteOpacity={satelliteOpacity}
          addHiveEnabled={emptySlotTargets.length > 0}
          onToggleEditMode={() => {
            setEditMode((prev) => !prev);
            setRotatingStandId(null);
            rotationDrag.current = null;
            closeContextMenu();
          }}
          onAddStand={handleAddStand}
          onAddHive={handleAddHive}
          onZoomIn={() => viewport.zoomBy(ZOOM_STEP * 2)}
          onZoomOut={() => viewport.zoomBy(-ZOOM_STEP * 2)}
          onFitAll={() => viewport.fitToContent(stands)}
          onSave={() => void handleSave()}
          onToggleSatellite={() => setSatelliteEnabled((prev) => !prev)}
          onSatelliteOpacityChange={setSatelliteOpacity}
        />
      </div>

      <div
        ref={surfaceRef}
        className="relative w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/30"
      >
        <canvas
          ref={gridCanvasRef}
          className="pointer-events-none absolute inset-0"
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
          onClick={(e) => {
            closeContextMenu();
            if (e.target === stageRef.current) setRotatingStandId(null);
            endRotationDrag();
          }}
          onTap={(e) => {
            closeContextMenu();
            if (e.target === stageRef.current) setRotatingStandId(null);
            endRotationDrag();
          }}
          onContextMenu={(e) => {
            // Swallow right-clicks on the empty background.
            if (e.target === stageRef.current) e.evt.preventDefault();
          }}
          onMouseMove={(e) => applyRotationFromPointer(e.evt.ctrlKey || e.evt.shiftKey)}
          onMouseUp={endRotationDrag}
          onTouchMove={(e) => {
            if (rotationDrag.current) {
              applyRotationFromPointer(false);
              return;
            }
            viewport.handlePinchMove(e);
          }}
          onTouchEnd={() => {
            endRotationDrag();
            viewport.endPinch();
          }}
        >
          <Layer>
            {satelliteEnabled &&
              satelliteAvailable &&
              apiary.latitude != null &&
              apiary.longitude != null && (
                <SatelliteLayer
                  latitude={apiary.latitude}
                  longitude={apiary.longitude}
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
              onRightClick={handleNorthRightClick}
              onRotateHandleDown={() => {
                rotationDrag.current = { kind: "north" };
              }}
            />

            {stands.map((stand) => (
              <StandGroup
                key={stand.id}
                stand={stand}
                slots={slotsByStand.get(stand.id) ?? []}
                hiveStatusById={hiveStatusById}
                hiveLabelById={hiveLabelById}
                editMode={editMode}
                isRotating={rotatingStandId === stand.id}
                draggingHiveId={draggingHiveId}
                dragOverSlot={dragOverSlot}
                onStandDragEnd={(standId, x, y) =>
                  dispatch({ type: "moveStand", standId, x, y })
                }
                onStandRightClick={handleStandRightClick}
                onSlotRightClick={handleSlotRightClick}
                onHiveRightClick={handleHiveRightClick}
                onHiveOpen={openHive}
                onHiveDragStart={handleHiveDragStart}
                onHiveDragMove={handleHiveDragMove}
                onHiveDragEnd={handleHiveDragEnd}
              />
            ))}

            {rotatingStand && (
              <RotationGizmo
                stand={rotatingStand}
                onHandleDown={() => {
                  rotationDrag.current = {
                    kind: "stand",
                    standId: rotatingStand.id,
                  };
                }}
              />
            )}

            {/* Empty-state hint */}
            {stands.length === 0 && (
              <KonvaText
                x={(0 - viewport.offset.x) / viewport.zoom}
                y={(dimensions.height / 2 - viewport.offset.y) / viewport.zoom}
                width={dimensions.width / viewport.zoom}
                text={
                  editMode
                    ? "Use “Add Stand” to lay out your first hive stand"
                    : "No stands yet — switch to Edit mode to lay out the yard"
                }
                fontSize={14}
                fill="#a1a1aa"
                align="center"
                listening={false}
              />
            )}
          </Layer>
        </Stage>

        {renderContextMenu()}

        {/* Mode indicator pill */}
        <div className="pointer-events-none absolute bottom-2 right-2 z-10">
          <span
            className={`rounded-full px-2 py-1 text-xs ${
              mode === "view"
                ? "bg-secondary text-secondary-foreground"
                : "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
            }`}
          >
            {modeText}
          </span>
        </div>
      </div>

      {/* Unassigned hives tray */}
      {unassigned.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 dark:border-amber-700/60 dark:bg-amber-950/40">
          <p className="mb-1 text-xs font-medium text-amber-800 dark:text-amber-300">
            Unplaced hives — drag stands into place, then assign:
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((hive) => (
              <button
                key={hive.id}
                type="button"
                className="rounded border bg-background px-2 py-1 text-xs transition-colors hover:bg-secondary"
                onClick={() => setDialog({ type: "moveToSlot", hiveId: hive.id })}
              >
                {hive.positionLabel} →
              </button>
            ))}
          </div>
        </div>
      )}

      {renderDialog()}
    </div>
  );
}
