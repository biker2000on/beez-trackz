"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type Konva from "konva";
import type { Map as LeafletMap } from "leaflet";
import { Layer, Stage, Text as KonvaText } from "react-konva";
import { toast } from "sonner";

import { Slider } from "@/components/ui/slider";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { DEFAULT_TILE_LAYER, type TileLayerId } from "@/features/map/tile-layers";

import {
  angleFromPivot,
  CELL_SIZE,
  GRID_SIZE,
  slotAtPoint,
  standCenter,
  standsBoundingBox,
  ZOOM_STEP,
} from "./lib/geometry";
import { useApiaryWeather } from "@/features/apiaries/hooks";
import {
  alignStandToPin,
  bakeStandsToGps,
  canvasOrigin,
  canvasToLatLng,
  PIN_ORIGIN,
  slotLatLng,
  slotWorldCenter,
  standHasGps,
  translateStandGps,
  yardCentroid,
  type GeoOverlayTransform,
} from "./lib/geo";
import { formatClock, solarPosition } from "./lib/solar";
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
import {
  useCanvasKeyboard,
  type CanvasFocusItem,
} from "./lib/use-canvas-keyboard";
import { useLayoutState } from "./lib/use-layout-state";
import { measureCanvasSurface } from "./lib/sizing";
import { useViewport } from "./lib/use-viewport";
import { FocusRing } from "./stage/focus-ring";
import { NorthArrow } from "./stage/north-arrow";
import { RotationGizmo } from "./stage/rotation-gizmo";
import { StandGroup, type DragOverSlot } from "./stage/stand-group";
import { SunLayer, type SunHiveMark } from "./stage/sun-layer";
import { YardMap, fitMapToStands } from "./stage/yard-map";
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
import { SetLocationDialog } from "./ui/set-location-dialog";
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
  | { type: "setLocation" }
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

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateFromScrubber(
  day: string,
  minutes: number,
  timeZone?: string,
): Date {
  const [y, m, d] = day.split("-").map(Number);
  const year = y || 1970;
  const month = m ?? 1;
  const date = d ?? 1;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (!timeZone) {
    return new Date(year, month - 1, date, hour, minute, 0, 0);
  }
  let utc = Date.UTC(year, month - 1, date, hour, minute, 0);
  try {
    // An unknown zone name (the value is Open-Meteo's echo, not ours) makes
    // Intl throw; fall back to the device zone rather than crash the page.
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return new Date(year, month - 1, date, hour, minute, 0, 0);
  }
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const num = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const asUTC = Date.UTC(
      num("year"),
      num("month") - 1,
      num("day"),
      num("hour"),
      num("minute"),
      num("second"),
    );
    const tzHours = (asUTC - utc) / 3_600_000;
    utc = Date.UTC(year, month - 1, date, hour, minute, 0) - tzHours * 3_600_000;
  }
  return new Date(utc);
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
  const access = useAccessProfile();
  // The detail page already blocks the pointer for viewers, but that does not
  // stop keys — the keyboard path checks the role itself.
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );

  const instructionsId = useId();

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tileLayer, setTileLayer] = useState<TileLayerId>(DEFAULT_TILE_LAYER);
  const [imageryOpacity, setImageryOpacity] = useState(1);
  const [sunEnabled, setSunEnabled] = useState(false);
  const [sunDay, setSunDay] = useState(todayInput);
  const [sunMinutes, setSunMinutes] = useState(
    () => new Date().getHours() * 60 + new Date().getMinutes(),
  );
  const [geo, setGeo] = useState<GeoOverlayTransform | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);

  const hasLocation = apiary.latitude != null && apiary.longitude != null;
  const pin = useMemo(() => {
    if (apiary.latitude == null || apiary.longitude == null) return null;
    return { lat: apiary.latitude, lng: apiary.longitude };
  }, [apiary.latitude, apiary.longitude]);

  const { stands, northArrow, mapView, dirty, generation, dispatch, markSaved } =
    useLayoutState({
      stands: initialLayout.stands ?? [],
      northArrow: initialLayout.northArrow,
      mapView: initialLayout.mapView,
    });

  const origin = useMemo(() => canvasOrigin(stands), [stands]);
  const weather = useApiaryWeather(apiary.id);
  const sunTimeZone = weather.data?.forecast.timezone;

  const bakedForPin = useRef<string | null>(null);
  useEffect(() => {
    if (!pin) {
      bakedForPin.current = null;
      return;
    }
    const key = `${pin.lat},${pin.lng}`;
    const missingGps = stands.some((stand) => !standHasGps(stand));
    if (missingGps) {
      const baked = bakeStandsToGps(stands, pin, canvasOrigin(stands));
      dispatch({
        type: "hydrateStands",
        stands: baked.map((stand) => alignStandToPin(stand, pin)),
        dirty: true,
      });
      bakedForPin.current = key;
      return;
    }
    if (bakedForPin.current === key) return;
    bakedForPin.current = key;
    const aligned = stands.map((stand) => alignStandToPin(stand, pin));
    const moved = aligned.some((stand, i) => stand.x !== stands[i].x || stand.y !== stands[i].y);
    if (moved) {
      dispatch({ type: "hydrateStands", stands: aligned, dirty: false });
    }
  }, [pin, stands, dispatch]);

  const markViewportDirty = useCallback(
    () => dispatch({ type: "markViewportDirty" }),
    [dispatch],
  );
  const viewport = useViewport(
    stageRef,
    dimensions,
    initialLayout,
    markViewportDirty,
  );

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

  const [draggingHiveId, setDraggingHiveId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<DragOverSlot | null>(null);
  const [rotatingStandId, setRotatingStandId] = useState<string | null>(null);
  const rotationDrag = useRef<RotationTarget | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [menuAutoFocus, setMenuAutoFocus] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMenuAutoFocus(false);
    // A keyboard-opened menu owns focus; hand it back to the stage on close.
    if (menuAutoFocus) surfaceRef.current?.focus();
  }, [menuAutoFocus]);
  const closeDialog = useCallback(() => setDialog(null), []);

  const rotatingStand = rotatingStandId
    ? (stands.find((s) => s.id === rotatingStandId) ?? null)
    : null;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const updateSize = () => {
      setDimensions(measureCanvasSurface(surface, window.innerHeight));
      mapRef.current?.invalidateSize();
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
    if (hasLocation) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, dimensions.width, dimensions.height);
      return;
    }
    drawGrid(
      canvas,
      dimensions.width,
      dimensions.height,
      viewport.zoom,
      viewport.offset.x,
      viewport.offset.y,
    );
  }, [dimensions, viewport.zoom, viewport.offset, hasLocation]);

  const handleSave = useCallback(async () => {
    const savedGeneration = generation;
    setSaving(true);
    try {
      await canvasApi.saveLayout({
        stands,
        northArrow,
        zoom: viewport.zoom,
        offsetX: viewport.offset.x,
        offsetY: viewport.offset.y,
        mapView,
      });
      markSaved(savedGeneration);
    } catch {
      toast.error("Could not save the layout. Your changes are still local.");
    } finally {
      setSaving(false);
    }
  }, [
    canvasApi,
    generation,
    stands,
    northArrow,
    viewport.zoom,
    viewport.offset,
    mapView,
    markSaved,
  ]);

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  useEffect(() => {
    // Viewers cannot save; without the gate a mount-time hydration marks the
    // layout dirty and fires a PUT that can only fail (or, worse, sync GPS).
    if (!dirty || !canEdit) return;
    const timer = setTimeout(() => void handleSaveRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [dirty, generation, canEdit]);

  const saveState: SaveState = saving ? "saving" : dirty ? "dirty" : "saved";

  const pointerToWorld = useCallback((): { x: number; y: number } | null => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return null;
    const layer = stage.getLayers()[0];
    if (hasLocation && layer) {
      return layer.getAbsoluteTransform().copy().invert().point(pointer);
    }
    return {
      x: (pointer.x - stage.x()) / stage.scaleX(),
      y: (pointer.y - stage.y()) / stage.scaleY(),
    };
  }, [hasLocation]);

  const handleGeoTransform = useCallback(
    (transform: GeoOverlayTransform, map: LeafletMap) => {
      mapRef.current = map;
      setGeo(transform);
    },
    [],
  );

  const handleMapViewChange = useCallback(
    (view: NonNullable<CanvasLayout["mapView"]>) => {
      dispatch({ type: "setMapView", mapView: view });
    },
    [dispatch],
  );

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

  const applyRotationFromPointer = useCallback(
    (snap: boolean) => {
      const target = rotationDrag.current;
      if (!target) return;
      const world = pointerToWorld();
      if (!world) return;

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
    [stands, northArrow.x, northArrow.y, dispatch, pointerToWorld],
  );

  const endRotationDrag = useCallback(() => {
    rotationDrag.current = null;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setRotatingStandId(null);
      rotationDrag.current = null;
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  const handleAddStand = useCallback(
    (rows: number, cols: number) => {
      if (hasLocation && pin) {
        const center = mapRef.current?.getCenter() ?? pin;
        const gps = { latitude: center.lat, longitude: center.lng };
        const aligned = alignStandToPin(
          {
            id: "new",
            label: "n",
            x: 0,
            y: 0,
            rotation: 0,
            rows,
            cols,
            ...gps,
          },
          pin,
        );
        dispatch({
          type: "addStand",
          rows,
          cols,
          x: aligned.x,
          y: aligned.y,
          latitude: gps.latitude,
          longitude: gps.longitude,
        });
        return;
      }
      const x =
        (dimensions.width / 2 - viewport.offset.x) / viewport.zoom - (cols * CELL_SIZE) / 2;
      const y =
        (dimensions.height / 2 - viewport.offset.y) / viewport.zoom - (rows * CELL_SIZE) / 2;
      dispatch({ type: "addStand", rows, cols, x, y });
    },
    [hasLocation, pin, dimensions, viewport.offset, viewport.zoom, dispatch],
  );

  /** Shared by stand dragging and keyboard nudging: move, then re-derive GPS. */
  const handleStandMove = useCallback(
    (standId: string, x: number, y: number) => {
      const stand = stands.find((item) => item.id === standId);
      if (pin && stand) {
        const cx = x + (stand.cols * CELL_SIZE) / 2;
        const cy = y + (stand.rows * CELL_SIZE) / 2;
        const ll = canvasToLatLng(cx, cy, pin, PIN_ORIGIN);
        dispatch({
          type: "moveStand",
          standId,
          x,
          y,
          latitude: ll.lat,
          longitude: ll.lng,
        });
        return;
      }
      dispatch({ type: "moveStand", standId, x, y });
    },
    [stands, pin, dispatch],
  );

  const handleZoomIn = useCallback(() => {
    if (hasLocation && mapRef.current) mapRef.current.zoomIn();
    else viewport.zoomBy(ZOOM_STEP * 2);
  }, [hasLocation, viewport]);

  const handleZoomOut = useCallback(() => {
    if (hasLocation && mapRef.current) mapRef.current.zoomOut();
    else viewport.zoomBy(-ZOOM_STEP * 2);
  }, [hasLocation, viewport]);

  const handleFitAll = useCallback(() => {
    if (hasLocation && pin && mapRef.current) {
      const corners = stands.flatMap((stand) => {
        if (standHasGps(stand)) {
          return [
            slotLatLng(stand, 0, 0, pin, origin),
            slotLatLng(stand, 0, stand.cols - 1, pin, origin),
            slotLatLng(stand, stand.rows - 1, 0, pin, origin),
            slotLatLng(stand, stand.rows - 1, stand.cols - 1, pin, origin),
          ];
        }
        const box = standsBoundingBox([stand]);
        if (!box) return [];
        return [
          canvasToLatLng(box.minX, box.minY, pin, origin),
          canvasToLatLng(box.maxX, box.maxY, pin, origin),
        ];
      });
      fitMapToStands(mapRef.current, corners.length > 0 ? corners : [pin]);
      return;
    }
    viewport.fitToContent(stands);
  }, [hasLocation, pin, stands, origin, viewport]);

  /** Screen position of a focused item, for anchoring the actions menu. */
  const itemScreenPosition = useCallback(
    (item: CanvasFocusItem): { x: number; y: number } | null => {
      const stand = stands.find((s) => s.id === item.standId);
      const stage = stageRef.current;
      const layer = stage?.getLayers()[0];
      if (!stand || !stage || !layer) return null;
      const world =
        item.kind === "hive"
          ? slotWorldCenter(stand, item.row, item.col)
          : standCenter(stand);
      const local = layer.getAbsoluteTransform().point(world);
      const rect = stage.container().getBoundingClientRect();
      return { x: rect.left + local.x, y: rect.top + local.y };
    },
    [stands],
  );

  const handleKeyboardActivate = useCallback(
    (item: CanvasFocusItem) => {
      const at = itemScreenPosition(item);
      if (item.kind === "hive") {
        // Viewers get the same thing a double-click gives them: the hive page.
        if (!canEdit || !at) {
          openHive(item.hiveId);
          return;
        }
        setMenuAutoFocus(true);
        handleHiveRightClick(item.hiveId, at.x, at.y);
        return;
      }
      if (!canEdit || !editMode || !at) return;
      setMenuAutoFocus(true);
      handleStandRightClick(item.standId, at.x, at.y);
    },
    [
      itemScreenPosition,
      canEdit,
      editMode,
      openHive,
      handleHiveRightClick,
      handleStandRightClick,
    ],
  );

  const handleKeyboardDelete = useCallback(
    (item: CanvasFocusItem) => {
      if (!canEdit || !editMode) return;
      if (item.kind === "stand") {
        setDialog({ type: "deleteStand", standId: item.standId });
        return;
      }
      void canvasApi.removeFromSlot(item.hiveId);
    },
    [canEdit, editMode, canvasApi],
  );

  const handleKeyboardNudge = useCallback(
    (standId: string, dx: number, dy: number) => {
      if (!canEdit || !editMode) return;
      const stand = stands.find((s) => s.id === standId);
      if (!stand) return;
      handleStandMove(standId, stand.x + dx, stand.y + dy);
    },
    [canEdit, editMode, stands, handleStandMove],
  );

  const keyboard = useCanvasKeyboard({
    stands,
    slotsByStand,
    hiveLabelById,
    canEdit,
    editMode,
    onNudgeStand: handleKeyboardNudge,
    onActivate: handleKeyboardActivate,
    onDelete: handleKeyboardDelete,
  });

  const sunWhen = useMemo(
    () => dateFromScrubber(sunDay, sunMinutes, sunTimeZone),
    [sunDay, sunMinutes, sunTimeZone],
  );
  const solar = useMemo(() => {
    if (!pin || !sunEnabled) return null;
    return solarPosition(pin.lat, pin.lng, sunWhen, sunTimeZone);
  }, [pin, sunEnabled, sunWhen, sunTimeZone]);

  const sunHives = useMemo((): { marks: SunHiveMark[]; usingPin: boolean } => {
    if (!pin) return { marks: [], usingPin: true };
    const marks: SunHiveMark[] = [];
    for (const stand of stands) {
      const slots = slotsByStand.get(stand.id) ?? [];
      for (const slot of slots) {
        if (slot.hives.length === 0) continue;
        const world = slotWorldCenter(stand, slot.row, slot.col);
        marks.push({
          x: world.x,
          y: world.y,
          w: CELL_SIZE * 0.7,
          h: CELL_SIZE * 0.7,
          rotation: stand.rotation,
        });
      }
    }
    return { marks, usingPin: marks.length === 0 };
  }, [pin, stands, slotsByStand]);

  function derivedHiveLatLng(hive: CanvasHive): { lat: number; lng: number } | null {
    if (hive.latitude != null && hive.longitude != null) {
      return { lat: hive.latitude, lng: hive.longitude };
    }
    if (!pin || hive.standId == null || hive.slotRow == null || hive.slotCol == null) {
      return null;
    }
    const stand = stands.find((s) => s.id === hive.standId);
    if (!stand) return null;
    return slotLatLng(stand, hive.slotRow, hive.slotCol, pin, origin);
  }

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
        <MenuSurface
          position={contextMenu.position}
          onClose={closeContextMenu}
          autoFocus={menuAutoFocus}
        >
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
      const derived = derivedHiveLatLng(hive);
      return (
        <MenuSurface
          position={contextMenu.position}
          onClose={closeContextMenu}
          autoFocus={menuAutoFocus}
        >
          <MenuHeading>{hive.positionLabel}</MenuHeading>
          {derived && (
            <p className="px-2 pb-1 font-mono text-[11px] text-muted-foreground">
              {derived.lat.toFixed(8)}, {derived.lng.toFixed(8)}
            </p>
          )}
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
      const derived =
        pin != null ? slotLatLng(stand, row, col, pin, origin) : null;

      return (
        <MenuSurface
          position={contextMenu.position}
          onClose={closeContextMenu}
          autoFocus={menuAutoFocus}
        >
          <MenuHeading>
            Slot {slotLabel} · Stand {stand.label}
          </MenuHeading>
          {derived && (
            <p className="px-2 pb-1 font-mono text-[11px] text-muted-foreground">
              {derived.lat.toFixed(8)}, {derived.lng.toFixed(8)}
            </p>
          )}
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
      <MenuSurface
        position={contextMenu.position}
        onClose={closeContextMenu}
        autoFocus={menuAutoFocus}
      >
        <MenuHeading>Stand {stand.label}</MenuHeading>
        <MenuSeparator />
        {renderStandMenuItems(stand)}
      </MenuSurface>
    );
  }

  function renderDialog() {
    if (!dialog) return null;

    if (dialog.type === "setLocation") {
      return (
        <SetLocationDialog
          apiaryId={apiary.id}
          name={apiary.name}
          notes={apiary.notes}
          value={{
            latitude: apiary.latitude,
            longitude: apiary.longitude,
            elevationM: apiary.elevationM,
            elevationSource:
              apiary.elevationSource === "geolocation" ||
              apiary.elevationSource === "terrain" ||
              apiary.elevationSource === "override"
                ? apiary.elevationSource
                : null,
          }}
          onRelocateStands={async (next) => {
            if (next.latitude == null || next.longitude == null) return;
            const dest = { lat: next.latitude, lng: next.longitude };
            let nextStands = stands;
            if (pin && nextStands.some((stand) => !standHasGps(stand))) {
              nextStands = bakeStandsToGps(nextStands, pin, canvasOrigin(nextStands));
            }
            const center = yardCentroid(nextStands);
            if (center) {
              nextStands = nextStands.map((stand) =>
                translateStandGps(stand, dest.lat - center.lat, dest.lng - center.lng),
              );
            }
            nextStands = nextStands.map((stand) => alignStandToPin(stand, dest));
            dispatch({ type: "hydrateStands", stands: nextStands, dirty: true });
            bakedForPin.current = `${dest.lat},${dest.lng}`;
            await canvasApi.saveLayout({
              stands: nextStands,
              northArrow,
              zoom: viewport.zoom,
              offsetX: viewport.offset.x,
              offsetY: viewport.offset.y,
              mapView,
            });
          }}
          onOpenChange={(open) => !open && closeDialog()}
        />
      );
    }

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

  const mode = draggingHiveId
    ? "dragging"
    : rotatingStandId
      ? "rotating"
      : editMode
        ? "edit"
        : "view";

  const modeText = {
    view: hasLocation
      ? "View mode — map pans and zooms; double-click a hive to open it"
      : "View mode — double-click a hive to open it, right-click for actions",
    edit: hasLocation
      ? "Edit mode — drag a stand to set its GPS; hive moves save instantly"
      : "Edit mode — hive moves save instantly; stand layout saves with Save",
    rotating: "Rotate mode — drag the handle (Ctrl/Shift snaps 45°), click the background to finish",
    dragging: "Drop the hive on a highlighted slot",
  }[mode];

  const stageListening =
    !hasLocation || editMode || overlayActive || Boolean(draggingHiveId);

  return (
    <div ref={containerRef} className="relative w-full min-w-0 max-w-full">
      <div className="absolute left-2 top-2 z-20">
        <CanvasToolbar
          editMode={editMode}
          saveState={saveState}
          hasLocation={hasLocation}
          tileLayer={tileLayer}
          imageryOpacity={imageryOpacity}
          sunEnabled={sunEnabled}
          addHiveEnabled={emptySlotTargets.length > 0}
          onToggleEditMode={() => {
            setEditMode((prev) => !prev);
            setRotatingStandId(null);
            rotationDrag.current = null;
            closeContextMenu();
          }}
          onAddStand={handleAddStand}
          onAddHive={handleAddHive}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onFitAll={handleFitAll}
          onSave={() => void handleSave()}
          onTileLayerChange={setTileLayer}
          onImageryOpacityChange={setImageryOpacity}
          onToggleSun={() => setSunEnabled((prev) => !prev)}
          onSetLocation={() => setDialog({ type: "setLocation" })}
        />
      </div>

      {sunEnabled && solar && (
        <div className="absolute right-2 top-2 z-20 flex max-w-sm flex-col gap-2 rounded-lg border bg-background p-2 shadow-sm">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={sunDay}
              onChange={(e) => setSunDay(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatClock(sunMinutes)}
            </span>
          </div>
          <Slider
            value={[sunMinutes]}
            onValueChange={(values) => setSunMinutes(values[0])}
            min={0}
            max={1439}
            step={5}
            className="w-56"
          />
          <p className="text-[11px] text-muted-foreground">
            Azimuth {Math.round(solar.azimuth)}° · solar alt {solar.altitude.toFixed(1)}°
            · rise {formatClock(solar.sunriseMinutes)}
            {solar.sunriseAzimuth != null ? ` @ ${Math.round(solar.sunriseAzimuth)}°` : ""}
            · set {formatClock(solar.sunsetMinutes)}
            {solar.sunsetAzimuth != null ? ` @ ${Math.round(solar.sunsetAzimuth)}°` : ""}
          </p>
        </div>
      )}

      <p id={instructionsId} className="sr-only">
        {keyboard.instructions}
      </p>
      <div aria-live="polite" className="sr-only">
        {keyboard.announcement}
      </div>

      <div
        ref={surfaceRef}
        tabIndex={0}
        role="application"
        aria-label={`Layout canvas for ${apiary.name}`}
        aria-describedby={instructionsId}
        onKeyDown={keyboard.handleKeyDown}
        className="relative w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onPointerMove={(e) => {
          if (!hasLocation || draggingHiveId) return;
          const stage = stageRef.current;
          if (!stage) return;
          const rect = stage.container().getBoundingClientRect();
          const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          setOverlayActive(Boolean(stage.getIntersection(pos)));
        }}
      >
        {hasLocation && pin && (
          <YardMap
            latitude={pin.lat}
            longitude={pin.lng}
            origin={origin}
            layerId={tileLayer}
            imageryOpacity={imageryOpacity}
            locked={false}
            initialView={mapView}
            onViewChange={handleMapViewChange}
            onTransform={handleGeoTransform}
          />
        )}

        <canvas
          ref={gridCanvasRef}
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ width: dimensions.width, height: dimensions.height }}
        />

        <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          scaleX={hasLocation ? 1 : viewport.zoom}
          scaleY={hasLocation ? 1 : viewport.zoom}
          x={hasLocation ? 0 : viewport.offset.x}
          y={hasLocation ? 0 : viewport.offset.y}
          draggable={!hasLocation}
          style={{
            position: "relative",
            zIndex: 2,
            pointerEvents: stageListening ? "auto" : "none",
          }}
          onWheel={(e) => {
            if (hasLocation && mapRef.current) {
              e.evt.preventDefault();
              const map = mapRef.current;
              const dir = e.evt.deltaY < 0 ? 0.5 : -0.5;
              const pt = map.mouseEventToContainerPoint(e.evt);
              map.setZoomAround(pt, map.getZoom() + dir);
              return;
            }
            viewport.handleWheel(e);
          }}
          onDragEnd={hasLocation ? undefined : viewport.handleStageDragEnd}
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
            if (e.target === stageRef.current) e.evt.preventDefault();
          }}
          onMouseMove={(e) => {
            applyRotationFromPointer(e.evt.ctrlKey || e.evt.shiftKey);
          }}
          onMouseUp={() => {
            endRotationDrag();
          }}
          onTouchMove={(e) => {
            if (rotationDrag.current) {
              applyRotationFromPointer(false);
              return;
            }
            if (!hasLocation) viewport.handlePinchMove(e);
          }}
          onTouchEnd={() => {
            endRotationDrag();
            if (!hasLocation) viewport.endPinch();
          }}
        >
          <Layer
            visible={!hasLocation || geo != null}
            x={hasLocation && geo ? geo.x : 0}
            y={hasLocation && geo ? geo.y : 0}
            offsetX={hasLocation && geo ? geo.offsetX : 0}
            offsetY={hasLocation && geo ? geo.offsetY : 0}
            scaleX={hasLocation && geo ? geo.scaleX : 1}
            scaleY={hasLocation && geo ? geo.scaleY : 1}
            rotation={hasLocation && geo ? geo.rotation : 0}
          >
            {!hasLocation && (
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
            )}

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
                onStandDragEnd={handleStandMove}
                onStandRightClick={handleStandRightClick}
                onSlotRightClick={handleSlotRightClick}
                onHiveRightClick={handleHiveRightClick}
                onHiveOpen={openHive}
                onHiveDragStart={handleHiveDragStart}
                onHiveDragMove={handleHiveDragMove}
                onHiveDragEnd={handleHiveDragEnd}
              />
            ))}

            <FocusRing item={keyboard.focusedItem} stands={stands} />

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

            {sunEnabled && solar && (
              <SunLayer
                origin={origin}
                solar={solar}
                hives={sunHives.marks}
                usingPin={sunHives.usingPin}
              />
            )}

            {stands.length === 0 && (
              <KonvaText
                x={
                  hasLocation
                    ? origin.x - 200
                    : (0 - viewport.offset.x) / viewport.zoom
                }
                y={
                  hasLocation
                    ? origin.y
                    : (dimensions.height / 2 - viewport.offset.y) / viewport.zoom
                }
                width={hasLocation ? 400 : dimensions.width / viewport.zoom}
                text={
                  !hasLocation
                    ? editMode
                      ? "Use “Add Stand” to lay out your first hive stand — Set location to put the yard on a map"
                      : "No stands yet — switch to Edit mode, or Set location for the map"
                    : editMode
                      ? "Use “Add Stand” to drop a stand at the map center"
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

      {/* Text fallback: everything the canvas draws, reachable without it. */}
      <ul className="sr-only">
        {keyboard.items.map((item) => (
          <li key={item.id}>
            {item.kind === "stand" ? (
              item.label
            ) : (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => openHive(item.hiveId)}
              >
                Open hive {item.label}
              </button>
            )}
          </li>
        ))}
      </ul>

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
