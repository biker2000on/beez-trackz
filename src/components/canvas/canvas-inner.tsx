"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Stage, Layer, Rect, Circle, Line, Text as KText } from "react-konva";
import { useRouter } from "next/navigation";
import type Konva from "konva";
import { StandGroup } from "./stand-group";
import { StandContextMenu } from "./stand-context-menu";
import { HiveContextMenu } from "./hive-context-menu";
import { HiveEditModal } from "./hive-edit-modal";
import { NorthArrow } from "./north-arrow";
import { CanvasToolbar } from "./canvas-toolbar";
import { SatelliteOverlay } from "./satellite-overlay";
import { saveCanvasLayout, createHiveFromCanvas } from "@/actions/canvas";
import type { CanvasLayout, Stand, Slot, SlotHive } from "@/lib/canvas/types";
import { createEmptyStand, getNextStandLabel, getSlotLabel } from "@/lib/canvas/types";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const GRID_SIZE = 40;
const CELL_SIZE = 60;

interface Hive {
  id: string;
  positionLabel: string;
  status: string;
  notes?: string | null;
}

interface CanvasInnerProps {
  apiaryId: string;
  hives: Hive[];
  initialLayout: CanvasLayout | null;
  latitude?: number | null;
  longitude?: number | null;
}

// Context menu state types
type ContextMenuState =
  | null
  | {
      type: "stand";
      position: { x: number; y: number };
      standId: string;
    }
  | {
      type: "slot";
      position: { x: number; y: number };
      standId: string;
      row: number;
      col: number;
    }
  | {
      type: "hive";
      position: { x: number; y: number };
      hiveId: string;
    };

/**
 * Migrate legacy flat hive positions to a single default stand.
 */
function migrateLegacyLayout(
  legacyHives: Record<string, { x: number; y: number }>,
  hives: Hive[]
): Stand[] {
  const hiveIds = Object.keys(legacyHives);
  if (hiveIds.length === 0 && hives.length === 0) return [];

  // All hives that have positions or exist in hives list
  const allHiveIds = new Set([...hiveIds, ...hives.map((h) => h.id)]);
  const count = allHiveIds.size;
  const cols = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / cols));

  const stand = createEmptyStand("A", rows, cols, 100, 100);

  // Assign hives to slots in order
  const hiveArray = Array.from(allHiveIds);
  hiveArray.forEach((hiveId, index) => {
    const slot = stand.slots[index];
    if (slot) {
      slot.hives.push({
        hiveId,
        facingDegrees: 0,
        placement: "full",
      });
    }
  });

  return [stand];
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
  latitude,
  longitude,
}: CanvasInnerProps) {
  const router = useRouter();
  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [editMode, setEditMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Satellite overlay state
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const [satelliteOpacity, setSatelliteOpacity] = useState(0.7);
  const hasSatelliteData = latitude != null && longitude != null;

  // Canvas state
  const [zoom, setZoom] = useState(initialLayout?.zoom ?? 1);
  const [offset, setOffset] = useState({
    x: initialLayout?.offsetX ?? 0,
    y: initialLayout?.offsetY ?? 0,
  });

  // Stands-based layout state (replaces flat hivePositions)
  const [stands, setStands] = useState<Stand[]>(() => {
    if (initialLayout?.stands && initialLayout.stands.length > 0) {
      return initialLayout.stands;
    }
    if (initialLayout?.hives && Object.keys(initialLayout.hives).length > 0) {
      return migrateLegacyLayout(initialLayout.hives, hives);
    }
    return [];
  });

  // Drag-and-drop state
  const [dragOverSlot, setDragOverSlot] = useState<{
    standId: string;
    row: number;
    col: number;
    canDrop: boolean;
    willStack: boolean;
  } | null>(null);
  const [draggingHiveId, setDraggingHiveId] = useState<string | null>(null);

  const [northArrow, setNorthArrow] = useState(
    initialLayout?.northArrow ?? { x: 40, y: 40, rotation: 0 }
  );

  // Rotation handle state
  const [rotatingStandId, setRotatingStandId] = useState<string | null>(null);
  const isRotationDragging = useRef(false);

  // Derived rotation pivot (center of stand in stage/world coords) — stable during rotation
  const rotatingStand = rotatingStandId ? stands.find((s) => s.id === rotatingStandId) : null;
  const rotationPivot = rotatingStand
    ? {
        x: rotatingStand.x + (rotatingStand.cols * CELL_SIZE) / 2,
        y: rotatingStand.y + (rotatingStand.rows * CELL_SIZE) / 2,
      }
    : null;

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // Edit modal state
  const [editModalHive, setEditModalHive] = useState<{ id: string; name: string; status: string; notes?: string } | null>(null);

  // Build lookup maps for StandGroup
  const hiveStatusMap: Record<string, string> = {};
  const hiveLabelMap: Record<string, string> = {};
  hives.forEach((h) => {
    hiveStatusMap[h.id] = h.status;
    hiveLabelMap[h.id] = h.positionLabel;
  });

  // Close context menu helper
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Handle edit hive save
  const handleEditHiveSave = useCallback(async (hiveId: string, data: { positionLabel: string; status: string; notes: string; placement?: string }) => {
    const { updateHiveFromCanvas } = await import("@/actions/canvas");
    await updateHiveFromCanvas(hiveId, data);
  }, []);

  // Sync DB hives into canvas slots — ensure all hives appear
  useEffect(() => {
    const hiveIdsInSlots = new Set<string>();
    stands.forEach(s => s.slots.forEach(slot => slot.hives.forEach(h => hiveIdsInSlots.add(h.hiveId))));

    const missingHives = hives.filter(h => !hiveIdsInSlots.has(h.id));
    if (missingHives.length === 0) return;

    // Also remove stale hive IDs from slots (hives that were deleted from DB)
    const dbHiveIds = new Set(hives.map(h => h.id));

    setStands(prev => {
      let updated = prev.map(s => ({
        ...s,
        slots: s.slots.map(slot => ({
          ...slot,
          hives: slot.hives.filter(h => dbHiveIds.has(h.hiveId)),
        })),
      }));

      // Add missing hives to first available empty slots
      const remaining = [...missingHives];
      for (const stand of updated) {
        for (const slot of stand.slots) {
          if (remaining.length === 0) break;
          if (slot.hives.length === 0) {
            slot.hives.push({
              hiveId: remaining.shift()!.id,
              facingDegrees: 0,
              placement: "full" as const,
            });
          }
        }
        if (remaining.length === 0) break;
      }

      return updated;
    });
    setHasUnsavedChanges(true);
  }, []); // Run once on mount

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

  // ============================================
  // Stand operations
  // ============================================

  const handleAddStand = useCallback(
    (rows: number, cols: number) => {
      if (!editMode) return;
      const label = getNextStandLabel(stands);
      // Place at center of current viewport
      const centerX = (dimensions.width / 2 - offset.x) / zoom;
      const centerY = (dimensions.height / 2 - offset.y) / zoom;
      const newStand = createEmptyStand(label, rows, cols, centerX - (cols * CELL_SIZE) / 2, centerY - (rows * CELL_SIZE) / 2);
      setStands((prev) => [...prev, newStand]);
      setHasUnsavedChanges(true);
    },
    [editMode, stands, dimensions, offset, zoom]
  );

  const handleStandDragEnd = useCallback(
    (standId: string, x: number, y: number) => {
      if (!editMode) return;
      setStands((prev) =>
        prev.map((s) => (s.id === standId ? { ...s, x, y } : s))
      );
      setHasUnsavedChanges(true);
    },
    [editMode]
  );

  const handleRotateStand = useCallback(
    (standId: string) => {
      if (!editMode) return;
      setRotatingStandId((prev) => (prev === standId ? null : standId));
      closeContextMenu();
    },
    [editMode, closeContextMenu]
  );

  const handleResizeStand = useCallback(
    (standId: string) => {
      if (!editMode) return;
      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;

      const rowsInput = window.prompt("Number of rows:", String(stand.rows));
      if (rowsInput === null) return;
      const newRows = Math.max(1, Math.min(8, parseInt(rowsInput) || stand.rows));

      const colsInput = window.prompt("Number of columns:", String(stand.cols));
      if (colsInput === null) return;
      const newCols = Math.max(1, Math.min(8, parseInt(colsInput) || stand.cols));

      setStands((prev) =>
        prev.map((s) => {
          if (s.id !== standId) return s;
          // Build new slots, preserving existing hives where possible
          const newSlots: Slot[] = [];
          for (let r = 0; r < newRows; r++) {
            for (let c = 0; c < newCols; c++) {
              const existing = s.slots.find(
                (slot) => slot.row === r && slot.col === c
              );
              newSlots.push(existing ?? { row: r, col: c, hives: [] });
            }
          }
          return { ...s, rows: newRows, cols: newCols, slots: newSlots };
        })
      );
      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, stands, closeContextMenu]
  );

  const handleRenameStand = useCallback(
    (standId: string) => {
      if (!editMode) return;
      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;
      const newLabel = window.prompt("New stand label:", stand.label);
      if (!newLabel) return;
      setStands((prev) =>
        prev.map((s) => (s.id === standId ? { ...s, label: newLabel } : s))
      );
      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, stands, closeContextMenu]
  );

  const handleDeleteStand = useCallback(
    (standId: string) => {
      if (!editMode) return;
      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;
      const hasHives = stand.slots.some((slot) => slot.hives.length > 0);
      if (hasHives) {
        const confirm = window.confirm(
          `Stand ${stand.label} has hives assigned. Remove stand anyway? (Hives will be unassigned, not deleted.)`
        );
        if (!confirm) return;
      }
      setStands((prev) => prev.filter((s) => s.id !== standId));
      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, stands, closeContextMenu]
  );

  // ============================================
  // Hive operations
  // ============================================

  const handleAddHiveToSlot = useCallback(
    async (standId: string, row: number, col: number) => {
      if (!editMode) return;
      closeContextMenu();

      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;
      const slotLabel = getSlotLabel(stand.label, row, col, stand.cols);

      try {
        const hive = await createHiveFromCanvas(apiaryId, slotLabel);
        setStands((prev) =>
          prev.map((s) => {
            if (s.id !== standId) return s;
            return {
              ...s,
              slots: s.slots.map((slot) => {
                if (slot.row !== row || slot.col !== col) return slot;
                return {
                  ...slot,
                  hives: [
                    ...slot.hives,
                    { hiveId: hive.id, facingDegrees: 0, placement: "full" as const },
                  ],
                };
              }),
            };
          })
        );
        setHasUnsavedChanges(true);
        // Refresh to pick up the new hive in the hives list
        router.refresh();
      } catch (error) {
        console.error("Failed to create hive:", error);
      }
    },
    [editMode, stands, apiaryId, router, closeContextMenu]
  );

  const handleSetFacing = useCallback(
    (hiveId: string) => {
      if (!editMode) return;
      const input = window.prompt("Enter facing direction in degrees (0=North, 90=East, 180=South, 270=West):", "0");
      if (input === null) return;
      const degrees = parseFloat(input);
      if (isNaN(degrees)) return;

      setStands((prev) =>
        prev.map((s) => ({
          ...s,
          slots: s.slots.map((slot) => ({
            ...slot,
            hives: slot.hives.map((h) =>
              h.hiveId === hiveId ? { ...h, facingDegrees: degrees % 360 } : h
            ),
          })),
        }))
      );
      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, closeContextMenu]
  );

  const handleMoveToSlot = useCallback(
    (hiveId: string) => {
      if (!editMode) return;
      // Build a list of available slots
      const options: string[] = [];
      const slotMap: { standId: string; row: number; col: number; label: string }[] = [];
      stands.forEach((stand) => {
        stand.slots.forEach((slot) => {
          if (slot.hives.length === 0) {
            const label = getSlotLabel(stand.label, slot.row, slot.col, stand.cols);
            options.push(`${label} (Stand ${stand.label})`);
            slotMap.push({ standId: stand.id, row: slot.row, col: slot.col, label });
          }
        });
      });

      if (options.length === 0) {
        window.alert("No empty slots available. Add a stand or resize an existing one.");
        closeContextMenu();
        return;
      }

      const input = window.prompt(
        `Move hive to which slot?\n\nAvailable:\n${options.join("\n")}\n\nEnter slot label (e.g. ${slotMap[0]?.label ?? "A1"}):`
      );
      if (!input) {
        closeContextMenu();
        return;
      }

      const target = slotMap.find(
        (s) => s.label.toLowerCase() === input.trim().toLowerCase()
      );
      if (!target) {
        window.alert("Slot not found or not empty.");
        closeContextMenu();
        return;
      }

      // Remove hive from current slot, add to target
      let movedHive: typeof stands[0]["slots"][0]["hives"][0] | undefined;

      setStands((prev) => {
        const updated = prev.map((s) => ({
          ...s,
          slots: s.slots.map((slot) => {
            const hiveIndex = slot.hives.findIndex((h) => h.hiveId === hiveId);
            if (hiveIndex >= 0) {
              movedHive = slot.hives[hiveIndex];
              return {
                ...slot,
                hives: slot.hives.filter((_, i) => i !== hiveIndex),
              };
            }
            return slot;
          }),
        }));

        if (!movedHive) return updated;

        return updated.map((s) => {
          if (s.id !== target.standId) return s;
          return {
            ...s,
            slots: s.slots.map((slot) => {
              if (slot.row !== target.row || slot.col !== target.col) return slot;
              return {
                ...slot,
                hives: [...slot.hives, movedHive!],
              };
            }),
          };
        });
      });

      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, stands, closeContextMenu]
  );

  const handleRemoveFromSlot = useCallback(
    (hiveId: string) => {
      if (!editMode) return;
      setStands((prev) =>
        prev.map((s) => ({
          ...s,
          slots: s.slots.map((slot) => ({
            ...slot,
            hives: slot.hives.filter((h) => h.hiveId !== hiveId),
          })),
        }))
      );
      setHasUnsavedChanges(true);
      closeContextMenu();
    },
    [editMode, closeContextMenu]
  );

  // Add an unassigned hive to the first empty slot, or prompt
  const handleAddHive = useCallback(() => {
    if (!editMode) return;
    if (stands.length === 0) {
      window.alert("Add a stand first before adding hives.");
      return;
    }

    // Find the first empty slot across all stands
    for (const stand of stands) {
      for (const slot of stand.slots) {
        if (slot.hives.length === 0) {
          handleAddHiveToSlot(stand.id, slot.row, slot.col);
          return;
        }
      }
    }
    window.alert("No empty slots available. Add a stand or resize an existing one.");
  }, [editMode, stands, handleAddHiveToSlot]);

  // ============================================
  // Drag-and-drop handlers
  // ============================================

  const handleHiveDragStart = useCallback((hiveId: string) => {
    if (!editMode) return;
    setDraggingHiveId(hiveId);
  }, [editMode]);

  const handleHiveDragMove = useCallback((hiveId: string, absX: number, absY: number) => {
    if (!editMode) return;

    // Find which slot the hive is over
    for (const stand of stands) {
      const totalW = stand.cols * CELL_SIZE;
      const totalH = stand.rows * CELL_SIZE;

      // Account for stand rotation
      const rad = -stand.rotation * (Math.PI / 180);
      const cx = stand.x + totalW / 2;
      const cy = stand.y + totalH / 2;
      const dx = absX - cx;
      const dy = absY - cy;
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad) + totalW / 2;
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad) + totalH / 2;

      if (localX >= 0 && localX < totalW && localY >= 0 && localY < totalH) {
        const col = Math.floor(localX / CELL_SIZE);
        const row = Math.floor(localY / CELL_SIZE);
        const slot = stand.slots.find(s => s.row === row && s.col === col);
        if (slot) {
          const otherHives = slot.hives.filter(h => h.hiveId !== hiveId);
          const canDrop = otherHives.length < 2;
          const willStack = otherHives.length === 1;
          setDragOverSlot({ standId: stand.id, row, col, canDrop, willStack });
          return;
        }
      }
    }
    setDragOverSlot(null);
  }, [editMode, stands]);

  const handleHiveDragEnd = useCallback((hiveId: string) => {
    if (!editMode || !dragOverSlot) {
      setDraggingHiveId(null);
      setDragOverSlot(null);
      return;
    }

    if (!dragOverSlot.canDrop) {
      setDraggingHiveId(null);
      setDragOverSlot(null);
      return;
    }

    // Move hive from source slot to target slot
    setStands(prev => {
      let movedHive: SlotHive | undefined;

      // Remove from current slot
      const updated = prev.map(s => ({
        ...s,
        slots: s.slots.map(slot => {
          const idx = slot.hives.findIndex(h => h.hiveId === hiveId);
          if (idx >= 0) {
            movedHive = slot.hives[idx];
            return { ...slot, hives: slot.hives.filter((_, i) => i !== idx) };
          }
          return slot;
        }),
      }));

      if (!movedHive) return updated;

      // Add to target slot
      return updated.map(s => {
        if (s.id !== dragOverSlot.standId) return s;
        return {
          ...s,
          slots: s.slots.map(slot => {
            if (slot.row !== dragOverSlot.row || slot.col !== dragOverSlot.col) return slot;
            // Auto-assign placement for stacking
            const existingHives = slot.hives;
            let placement = movedHive!.placement;
            if (existingHives.length === 1) {
              // Stack: existing becomes bottom, new becomes top
              const existingUpdated = existingHives.map(h => ({
                ...h,
                placement: "bottom" as const,
              }));
              placement = "top";
              return { ...slot, hives: [...existingUpdated, { ...movedHive!, placement }] };
            }
            return { ...slot, hives: [...slot.hives, movedHive!] };
          }),
        };
      });
    });

    setHasUnsavedChanges(true);
    setDraggingHiveId(null);
    setDragOverSlot(null);
  }, [editMode, dragOverSlot]);

  // ============================================
  // Context menu event handlers from StandGroup
  // ============================================

  const handleStandRightClick = useCallback(
    (standId: string, screenX: number, screenY: number) => {
      if (!editMode) return;
      // Adjust for container offset
      const containerRect = containerRef.current?.getBoundingClientRect();
      setContextMenu({
        type: "stand",
        position: {
          x: screenX - (containerRect?.left ?? 0),
          y: screenY - (containerRect?.top ?? 0),
        },
        standId,
      });
    },
    [editMode]
  );

  const handleSlotRightClick = useCallback(
    (standId: string, row: number, col: number, screenX: number, screenY: number) => {
      if (!editMode) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      setContextMenu({
        type: "slot",
        position: {
          x: screenX - (containerRect?.left ?? 0),
          y: screenY - (containerRect?.top ?? 0),
        },
        standId,
        row,
        col,
      });
    },
    [editMode]
  );

  const handleHiveRightClick = useCallback(
    (hiveId: string, screenX: number, screenY: number) => {
      const containerRect = containerRef.current?.getBoundingClientRect();
      setContextMenu({
        type: "hive",
        position: {
          x: screenX - (containerRect?.left ?? 0),
          y: screenY - (containerRect?.top ?? 0),
        },
        hiveId,
      });
    },
    []
  );

  const handleHiveDoubleTap = useCallback(
    (hiveId: string) => {
      router.push(`/hives/${hiveId}`);
    },
    [router]
  );

  // ============================================
  // North arrow handlers
  // ============================================

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

  // ============================================
  // Zoom / Pan
  // ============================================

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

  // ============================================
  // Toolbar actions
  // ============================================

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(MAX_ZOOM, prev + ZOOM_STEP * 2));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(MIN_ZOOM, prev - ZOOM_STEP * 2));
  }, []);

  const handleResetView = useCallback(() => {
    if (stands.length === 0) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }

    // Compute bounding box of all stands
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    stands.forEach((stand) => {
      const w = stand.cols * CELL_SIZE;
      const h = stand.rows * CELL_SIZE;
      minX = Math.min(minX, stand.x);
      minY = Math.min(minY, stand.y);
      maxX = Math.max(maxX, stand.x + w);
      maxY = Math.max(maxY, stand.y + h);
    });

    if (!isFinite(minX)) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }

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
  }, [stands, dimensions]);

  const handleToggleEditMode = useCallback(() => {
    setEditMode((prev) => !prev);
    closeContextMenu();
    setRotatingStandId(null);
  }, [closeContextMenu]);

  const handleToggleSatellite = useCallback(() => {
    setSatelliteEnabled((prev) => !prev);
  }, []);

  const handleSatelliteOpacityChange = useCallback((opacity: number) => {
    setSatelliteOpacity(opacity);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const layout: CanvasLayout = {
        stands,
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
  }, [apiaryId, stands, northArrow, zoom, offset]);

  // ============================================
  // Grid drawing
  // ============================================

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

  // ============================================
  // Render context menu helpers
  // ============================================

  function renderContextMenu() {
    if (!contextMenu) return null;

    if (contextMenu.type === "hive") {
      const hiveData = hives.find((h) => h.id === contextMenu.hiveId);
      return (
        <HiveContextMenu
          position={contextMenu.position}
          hiveId={contextMenu.hiveId}
          hiveName={hiveData?.positionLabel ?? "Hive"}
          onClose={closeContextMenu}
          onSetFacing={() => handleSetFacing(contextMenu.hiveId)}
          onMoveToSlot={() => handleMoveToSlot(contextMenu.hiveId)}
          onRemoveFromSlot={() => handleRemoveFromSlot(contextMenu.hiveId)}
          onEditHive={() => {
            const hive = hives.find(h => h.id === contextMenu.hiveId);
            setEditModalHive({
              id: contextMenu.hiveId,
              name: hive?.positionLabel ?? "",
              status: hive?.status ?? "active",
              notes: hive?.notes ?? undefined,
            });
            closeContextMenu();
          }}
        />
      );
    }

    if (contextMenu.type === "slot") {
      const stand = stands.find((s) => s.id === contextMenu.standId);
      if (!stand) return null;
      const slot = stand.slots.find(
        (s) => s.row === contextMenu.row && s.col === contextMenu.col
      );
      const slotLabel = getSlotLabel(
        stand.label,
        contextMenu.row,
        contextMenu.col,
        stand.cols
      );
      const slotOccupied = (slot?.hives.length ?? 0) > 0;

      return (
        <StandContextMenu
          position={contextMenu.position}
          standLabel={stand.label}
          slotLabel={slotLabel}
          slotOccupied={slotOccupied}
          isMultiOccupant={(slot?.hives.length ?? 0) > 1}
          onClose={closeContextMenu}
          onRenameStand={() => handleRenameStand(contextMenu.standId)}
          onResizeStand={() => handleResizeStand(contextMenu.standId)}
          onRotateStand={() => handleRotateStand(contextMenu.standId)}
          onDeleteStand={() => handleDeleteStand(contextMenu.standId)}
          onAddNewHive={
            !slotOccupied
              ? () =>
                  handleAddHiveToSlot(
                    contextMenu.standId,
                    contextMenu.row,
                    contextMenu.col
                  )
              : undefined
          }
          onRemoveHiveFromSlot={
            slotOccupied && slot?.hives[0]
              ? () => handleRemoveFromSlot(slot!.hives[0].hiveId)
              : undefined
          }
        />
      );
    }

    if (contextMenu.type === "stand") {
      const stand = stands.find((s) => s.id === contextMenu.standId);
      if (!stand) return null;

      return (
        <StandContextMenu
          position={contextMenu.position}
          standLabel={stand.label}
          onClose={closeContextMenu}
          onRenameStand={() => handleRenameStand(contextMenu.standId)}
          onResizeStand={() => handleResizeStand(contextMenu.standId)}
          onRotateStand={() => handleRotateStand(contextMenu.standId)}
          onDeleteStand={() => handleDeleteStand(contextMenu.standId)}
        />
      );
    }

    return null;
  }

  return (
    <div className="relative" ref={containerRef}>
      <div className="absolute top-2 left-2 z-10">
        <CanvasToolbar
          editMode={editMode}
          hasUnsavedChanges={hasUnsavedChanges}
          isSaving={isSaving}
          satelliteEnabled={satelliteEnabled}
          satelliteOpacity={satelliteOpacity}
          onToggleEditMode={handleToggleEditMode}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetView={handleResetView}
          onSave={handleSave}
          onToggleSatellite={hasSatelliteData ? handleToggleSatellite : undefined}
          onSatelliteOpacityChange={hasSatelliteData ? handleSatelliteOpacityChange : undefined}
          onAddStand={handleAddStand}
          onAddHive={handleAddHive}
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
          onClick={() => { closeContextMenu(); setRotatingStandId(null); isRotationDragging.current = false; }}
          onTap={() => { closeContextMenu(); setRotatingStandId(null); isRotationDragging.current = false; }}
          onMouseMove={(e) => {
            if (!isRotationDragging.current || !rotationPivot || !rotatingStandId) return;
            const stage = stageRef.current;
            if (!stage) return;
            const pointer = stage.getPointerPosition();
            if (!pointer) return;
            // Convert screen pointer to world/stage coords (account for zoom/pan)
            const worldX = (pointer.x - stage.x()) / stage.scaleX();
            const worldY = (pointer.y - stage.y()) / stage.scaleY();
            const dx = worldX - rotationPivot.x;
            const dy = worldY - rotationPivot.y;
            // Compute angle: 0 = north/up, clockwise positive
            let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
            angle = ((angle % 360) + 360) % 360;
            // Snap to 45° only when Ctrl or Shift is held
            if (e.evt.ctrlKey || e.evt.shiftKey) {
              angle = Math.round(angle / 45) * 45;
            }
            angle = Math.round(angle);
            setStands((prev) =>
              prev.map((s) => (s.id === rotatingStandId ? { ...s, rotation: angle } : s))
            );
            setHasUnsavedChanges(true);
          }}
          onMouseUp={() => {
            isRotationDragging.current = false;
          }}
          onTouchMove={(e) => {
            // Handle rotation drag via touch
            if (isRotationDragging.current && rotationPivot && rotatingStandId) {
              const stage = stageRef.current;
              if (!stage) return;
              const pointer = stage.getPointerPosition();
              if (!pointer) return;
              const worldX = (pointer.x - stage.x()) / stage.scaleX();
              const worldY = (pointer.y - stage.y()) / stage.scaleY();
              const dx = worldX - rotationPivot.x;
              const dy = worldY - rotationPivot.y;
              let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
              angle = ((angle % 360) + 360) % 360;
              angle = Math.round(angle);
              setStands((prev) =>
                prev.map((s) => (s.id === rotatingStandId ? { ...s, rotation: angle } : s))
              );
              setHasUnsavedChanges(true);
              return;
            }

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
            isRotationDragging.current = false;
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

            {/* Satellite overlay - rendered behind everything else */}
            {satelliteEnabled && hasSatelliteData && latitude != null && longitude != null && (
              <SatelliteOverlay
                latitude={latitude}
                longitude={longitude}
                canvasWidth={dimensions.width / zoom}
                canvasHeight={dimensions.height / zoom}
                opacity={satelliteOpacity}
              />
            )}

            {/* North arrow */}
            <NorthArrow
              x={northArrow.x}
              y={northArrow.y}
              rotation={northArrow.rotation}
              draggable={editMode}
              onDragEnd={handleNorthDragEnd}
              onRotate={handleNorthRotate}
            />

            {/* Stands */}
            {stands.map((stand) => (
              <StandGroup
                key={stand.id}
                stand={stand}
                hiveStatusMap={hiveStatusMap}
                hiveLabelMap={hiveLabelMap}
                editMode={editMode}
                isRotating={rotatingStandId === stand.id}
                draggingHiveId={draggingHiveId}
                dragOverSlot={dragOverSlot?.standId === stand.id ? dragOverSlot : null}
                onStandDragEnd={handleStandDragEnd}
                onHiveRightClick={handleHiveRightClick}
                onSlotRightClick={handleSlotRightClick}
                onStandRightClick={handleStandRightClick}
                onHiveDoubleTap={handleHiveDoubleTap}
                onHiveDragStart={handleHiveDragStart}
                onHiveDragMove={handleHiveDragMove}
                onHiveDragEnd={handleHiveDragEnd}
              />
            ))}

            {/* Rotation handle overlay — rendered in stage coords, outside the rotated group */}
            {rotatingStand && rotationPivot && (() => {
              const rad = rotatingStand.rotation * (Math.PI / 180);
              const handleDist =
                Math.max(rotatingStand.cols, rotatingStand.rows) * CELL_SIZE / 2 + 50;
              const hx = rotationPivot.x + Math.sin(rad) * handleDist;
              const hy = rotationPivot.y - Math.cos(rad) * handleDist;
              return (
                <>
                  {/* Dashed line from center to handle */}
                  <Line
                    points={[rotationPivot.x, rotationPivot.y, hx, hy]}
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    dash={[4, 4]}
                    listening={false}
                  />
                  {/* Center pivot dot */}
                  <Circle
                    x={rotationPivot.x}
                    y={rotationPivot.y}
                    radius={4}
                    fill="#f59e0b"
                    listening={false}
                  />
                  {/* Draggable rotation handle */}
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
                    onClick={(e) => { e.cancelBubble = true; }}
                    onTap={(e) => { e.cancelBubble = true; }}
                    onMouseEnter={(e) => {
                      const c = e.target.getStage()?.container();
                      if (c) c.style.cursor = "grab";
                    }}
                    onMouseLeave={(e) => {
                      const c = e.target.getStage()?.container();
                      if (c) c.style.cursor = "default";
                    }}
                  />
                  {/* Rotation degree label */}
                  <KText
                    x={hx - 20}
                    y={hy + 16}
                    width={40}
                    text={`${Math.round(rotatingStand.rotation)}\u00B0`}
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

        {/* Context menus - HTML overlays positioned absolutely over the canvas */}
        {renderContextMenu()}
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
            ? rotatingStandId
              ? "Rotate Mode - Drag handle to rotate (hold Ctrl/Shift to snap 45\u00B0), click background to confirm"
              : "Edit Mode - Drag stands to reposition, right-click for options"
            : "View Mode - Double-click hive to open, right-click for quick actions"}
        </span>
      </div>

      {/* Edit Hive Modal */}
      {editModalHive && (
        <HiveEditModal
          open={!!editModalHive}
          onOpenChange={(open) => { if (!open) setEditModalHive(null); }}
          hiveId={editModalHive.id}
          hiveName={editModalHive.name}
          hiveStatus={editModalHive.status}
          hiveNotes={editModalHive.notes}
          onSave={handleEditHiveSave}
        />
      )}
    </div>
  );
}
