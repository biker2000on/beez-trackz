"use client";

import { Circle, Line, Text } from "react-konva";

import { standCenter, standSize } from "../lib/geometry";
import type { StandGeometry } from "../lib/types";

interface RotationGizmoProps {
  stand: StandGeometry;
  onHandleDown: () => void;
}

/**
 * Rotate-mode overlay for a stand: pivot dot, dashed line, grab handle,
 * and a live degree readout. The parent tracks pointer movement while the
 * handle is held and dispatches rotation updates.
 */
export function RotationGizmo({ stand, onHandleDown }: RotationGizmoProps) {
  const pivot = standCenter(stand);
  const { w, h } = standSize(stand);
  const rad = stand.rotation * (Math.PI / 180);
  const handleDist = Math.max(w, h) / 2 + 50;
  const hx = pivot.x + Math.sin(rad) * handleDist;
  const hy = pivot.y - Math.cos(rad) * handleDist;

  return (
    <>
      <Line
        points={[pivot.x, pivot.y, hx, hy]}
        stroke="#f59e0b"
        strokeWidth={1.5}
        dash={[4, 4]}
        listening={false}
      />
      <Circle x={pivot.x} y={pivot.y} radius={4} fill="#f59e0b" listening={false} />
      <Circle
        x={hx}
        y={hy}
        radius={12}
        fill="#f59e0b"
        stroke="#b45309"
        strokeWidth={2}
        onMouseDown={(e) => {
          e.cancelBubble = true;
          onHandleDown();
        }}
        onTouchStart={(e) => {
          e.cancelBubble = true;
          onHandleDown();
        }}
        onClick={(e) => {
          e.cancelBubble = true;
        }}
        onTap={(e) => {
          e.cancelBubble = true;
        }}
        onMouseEnter={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = "grab";
        }}
        onMouseLeave={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = "default";
        }}
      />
      <Text
        x={hx - 20}
        y={hy + 16}
        width={40}
        text={`${Math.round(stand.rotation)}°`}
        fontSize={11}
        fontStyle="bold"
        fill="#b45309"
        align="center"
        listening={false}
      />
    </>
  );
}
