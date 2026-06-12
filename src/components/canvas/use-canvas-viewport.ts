"use client";

import { useCallback, useRef, useState } from "react";
import type Konva from "konva";
import type { StandGeometry } from "@/lib/canvas/types";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  standsBoundingBox,
} from "@/lib/canvas/geometry";

const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/**
 * Zoom/pan/pinch state for the canvas stage. Wheel zoom anchors on the
 * cursor; pinch zoom anchors on the pinch midpoint (and pans with it).
 */
export function useCanvasViewport(
  stageRef: React.RefObject<Konva.Stage | null>,
  dimensions: { width: number; height: number },
  initial: { zoom?: number; offsetX?: number; offsetY?: number } | null
) {
  const [zoom, setZoom] = useState(initial?.zoom ?? 1);
  const [offset, setOffset] = useState({
    x: initial?.offsetX ?? 0,
    y: initial?.offsetY ?? 0,
  });
  const lastPinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      setZoom((oldZoom) => {
        const direction = e.evt.deltaY < 0 ? 1 : -1;
        const newZoom = clampZoom(oldZoom + direction * ZOOM_STEP);
        setOffset((oldOffset) => {
          const worldX = (pointer.x - oldOffset.x) / oldZoom;
          const worldY = (pointer.y - oldOffset.y) / oldZoom;
          return {
            x: pointer.x - worldX * newZoom,
            y: pointer.y - worldY * newZoom,
          };
        });
        return newZoom;
      });
    },
    [stageRef]
  );

  /** Returns true when the event was consumed as a pinch gesture. */
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
      const rect = stage.container().getBoundingClientRect();
      const mid = {
        x: (t1.clientX + t2.clientX) / 2 - rect.left,
        y: (t1.clientY + t2.clientY) / 2 - rect.top,
      };
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      const prev = lastPinch.current;
      lastPinch.current = { dist, mid };
      if (!prev) return true;

      setZoom((oldZoom) => {
        const newZoom = clampZoom(oldZoom * (dist / prev.dist));
        setOffset((oldOffset) => {
          // Keep the world point under the previous midpoint pinned to the
          // new midpoint, so the gesture both zooms and pans naturally.
          const worldX = (prev.mid.x - oldOffset.x) / oldZoom;
          const worldY = (prev.mid.y - oldOffset.y) / oldZoom;
          return { x: mid.x - worldX * newZoom, y: mid.y - worldY * newZoom };
        });
        return newZoom;
      });
      return true;
    },
    [stageRef]
  );

  const endPinch = useCallback(() => {
    lastPinch.current = null;
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setZoom((prev) => clampZoom(prev + delta));
  }, []);

  const handleStageDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      if (e.target !== stageRef.current) return;
      setOffset({ x: e.target.x(), y: e.target.y() });
    },
    [stageRef]
  );

  const fitToContent = useCallback(
    (stands: StandGeometry[]) => {
      const box = standsBoundingBox(stands);
      if (!box) {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
        return;
      }
      const contentWidth = box.maxX - box.minX;
      const contentHeight = box.maxY - box.minY;
      const padding = 80;
      const newZoom = clampZoom(
        Math.min(
          (dimensions.width - padding * 2) / contentWidth,
          (dimensions.height - padding * 2) / contentHeight
        )
      );
      setZoom(newZoom);
      setOffset({
        x: (dimensions.width - contentWidth * newZoom) / 2 - box.minX * newZoom,
        y: (dimensions.height - contentHeight * newZoom) / 2 - box.minY * newZoom,
      });
    },
    [dimensions]
  );

  return {
    zoom,
    offset,
    handleWheel,
    handlePinchMove,
    endPinch,
    zoomBy,
    handleStageDragEnd,
    fitToContent,
  };
}
