"use client";

import { useCallback, useRef, useState } from "react";
import type Konva from "konva";

import { clampZoom, standsBoundingBox, ZOOM_STEP } from "./geometry";
import type { StandGeometry } from "./types";

interface ViewportState {
  zoom: number;
  offset: { x: number; y: number };
}

/** Anchored zoom: keeps the world point under `anchor` fixed on screen. */
function zoomTo(
  current: ViewportState,
  newZoomRaw: number,
  anchor: { x: number; y: number },
): ViewportState {
  const newZoom = clampZoom(newZoomRaw);
  const worldX = (anchor.x - current.offset.x) / current.zoom;
  const worldY = (anchor.y - current.offset.y) / current.zoom;
  return {
    zoom: newZoom,
    offset: { x: anchor.x - worldX * newZoom, y: anchor.y - worldY * newZoom },
  };
}

/**
 * Zoom/pan/pinch state for the canvas stage. Wheel zoom anchors on the
 * cursor; pinch zoom anchors on the pinch midpoint (and pans with it).
 * Zoom and offset live in one state object so anchored updates are atomic
 * (pure updaters — safe under StrictMode double-invocation).
 *
 * `onUserChange` fires after any user-driven viewport change so the caller
 * can mark the layout dirty (the viewport persists in the layout blob).
 */
export function useViewport(
  stageRef: React.RefObject<Konva.Stage | null>,
  dimensions: { width: number; height: number },
  initial: { zoom?: number; offsetX?: number; offsetY?: number } | null,
  onUserChange?: () => void,
) {
  const [viewport, setViewport] = useState<ViewportState>(() => ({
    zoom: clampZoom(initial?.zoom ?? 1),
    offset: { x: initial?.offsetX ?? 0, y: initial?.offsetY ?? 0 },
  }));
  const lastPinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(
    null,
  );

  const notifyChange = useCallback(() => {
    onUserChange?.();
  }, [onUserChange]);

  const zoomAnchored = useCallback(
    (newZoomRaw: number, anchor: { x: number; y: number }) => {
      setViewport((v) => zoomTo(v, newZoomRaw, anchor));
      notifyChange();
    },
    [notifyChange],
  );

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      const direction = e.evt.deltaY < 0 ? 1 : -1;
      setViewport((v) => zoomTo(v, v.zoom + direction * ZOOM_STEP, pointer));
      notifyChange();
    },
    [stageRef, notifyChange],
  );

  /** Returns true when the touch event was consumed as a pinch gesture. */
  const handlePinchMove = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>): boolean => {
      const [t1, t2] = [e.evt.touches[0], e.evt.touches[1]];
      if (!t1 || !t2) {
        lastPinch.current = null;
        return false;
      }
      e.evt.preventDefault();

      const stage = stageRef.current;
      if (!stage) return true;
      // The first finger started a Konva stage drag (pan); stop it, or it
      // keeps overriding the pinch's zoom/offset every pointer move.
      if (stage.isDragging()) stage.stopDrag();
      const rect = stage.container().getBoundingClientRect();
      const mid = {
        x: (t1.clientX + t2.clientX) / 2 - rect.left,
        y: (t1.clientY + t2.clientY) / 2 - rect.top,
      };
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      const prev = lastPinch.current;
      lastPinch.current = { dist, mid };
      if (!prev) return true;

      setViewport((v) => {
        const newZoom = clampZoom(v.zoom * (dist / prev.dist));
        // Keep the world point under the previous midpoint pinned to the
        // new midpoint, so the gesture both zooms and pans naturally.
        const worldX = (prev.mid.x - v.offset.x) / v.zoom;
        const worldY = (prev.mid.y - v.offset.y) / v.zoom;
        return {
          zoom: newZoom,
          offset: { x: mid.x - worldX * newZoom, y: mid.y - worldY * newZoom },
        };
      });
      notifyChange();
      return true;
    },
    [stageRef, notifyChange],
  );

  const endPinch = useCallback(() => {
    // Konva's dragend can fire during the same touchend; clear on the next
    // tick so handleStageDragEnd still sees the pinch and skips the clobber.
    setTimeout(() => {
      lastPinch.current = null;
    }, 0);
  }, []);

  /** Toolbar zoom buttons: anchor on the viewport center. */
  const zoomBy = useCallback(
    (delta: number) => {
      const anchor = { x: dimensions.width / 2, y: dimensions.height / 2 };
      setViewport((v) => zoomTo(v, v.zoom + delta, anchor));
      notifyChange();
    },
    [dimensions, notifyChange],
  );

  const handleStageDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      if (e.target !== stageRef.current) return;
      // A pinch already anchored the offset and stopped this drag; don't let
      // the drag-end position clobber it.
      if (lastPinch.current) return;
      const position = { x: e.target.x(), y: e.target.y() };
      setViewport((v) => ({ ...v, offset: position }));
      notifyChange();
    },
    [stageRef, notifyChange],
  );

  const fitToContent = useCallback(
    (stands: StandGeometry[]) => {
      const box = standsBoundingBox(stands);
      if (!box) {
        setViewport({ zoom: 1, offset: { x: 0, y: 0 } });
        notifyChange();
        return;
      }
      const contentWidth = Math.max(1, box.maxX - box.minX);
      const contentHeight = Math.max(1, box.maxY - box.minY);
      const padding = 80;
      const newZoom = clampZoom(
        Math.min(
          (dimensions.width - padding * 2) / contentWidth,
          (dimensions.height - padding * 2) / contentHeight,
        ),
      );
      setViewport({
        zoom: newZoom,
        offset: {
          x: (dimensions.width - contentWidth * newZoom) / 2 - box.minX * newZoom,
          y: (dimensions.height - contentHeight * newZoom) / 2 - box.minY * newZoom,
        },
      });
      notifyChange();
    },
    [dimensions, notifyChange],
  );

  return {
    zoom: viewport.zoom,
    offset: viewport.offset,
    zoomAnchored,
    handleWheel,
    handlePinchMove,
    endPinch,
    zoomBy,
    handleStageDragEnd,
    fitToContent,
  };
}
