"use client";

import { Rect } from "react-konva";

import { CELL_SIZE, standCenter, standSize } from "../lib/geometry";
import { slotWorldCenter } from "../lib/geo";
import type { CanvasFocusItem } from "../lib/use-canvas-keyboard";
import type { StandGeometry } from "../lib/types";

const RING_COLOR = "#2563eb";

/**
 * Visible marker for the keyboard's roving focus. Konva shapes cannot take DOM
 * focus, so the ring is drawn into the stand layer instead of being an outline
 * on a focusable element.
 */
export function FocusRing({
  item,
  stands,
}: {
  item: CanvasFocusItem | null;
  stands: StandGeometry[];
}) {
  if (!item) return null;
  const stand = stands.find((s) => s.id === item.standId);
  if (!stand) return null;

  if (item.kind === "stand") {
    const { w, h } = standSize(stand);
    const center = standCenter(stand);
    return (
      <Rect
        x={center.x}
        y={center.y}
        offsetX={w / 2 + 4}
        offsetY={h / 2 + 4}
        width={w + 8}
        height={h + 8}
        rotation={stand.rotation}
        stroke={RING_COLOR}
        strokeWidth={2.5}
        dash={[6, 4]}
        cornerRadius={6}
        listening={false}
      />
    );
  }

  const center = slotWorldCenter(stand, item.row, item.col);
  return (
    <Rect
      x={center.x}
      y={center.y}
      offsetX={CELL_SIZE / 2 - 1}
      offsetY={CELL_SIZE / 2 - 1}
      width={CELL_SIZE - 2}
      height={CELL_SIZE - 2}
      rotation={stand.rotation}
      stroke={RING_COLOR}
      strokeWidth={2.5}
      cornerRadius={4}
      listening={false}
    />
  );
}
