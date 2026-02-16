"use client";

import { useCallback } from "react";
import { Group, Arrow, Text, Circle } from "react-konva";
import type Konva from "konva";

interface NorthArrowProps {
  x: number;
  y: number;
  rotation: number;
  draggable: boolean;
  onDragEnd: (x: number, y: number) => void;
  onRotate: (rotation: number) => void;
  onRightClick?: (screenX: number, screenY: number) => void;
}

export function NorthArrow({
  x,
  y,
  rotation,
  draggable,
  onDragEnd,
  onRotate,
  onRightClick,
}: NorthArrowProps) {
  const handleDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      onDragEnd(e.target.x(), e.target.y());
    },
    [onDragEnd]
  );

  const handleTransformEnd = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      onRotate(node.rotation());
    },
    [onRotate]
  );

  return (
    <Group
      x={x}
      y={y}
      rotation={rotation}
      draggable={draggable}
      onDragEnd={handleDragEnd}
      onTransformEnd={handleTransformEnd}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        if (!onRightClick) return;
        const stage = e.target.getStage();
        if (!stage) return;
        const container = stage.container().getBoundingClientRect();
        const pointer = stage.getPointerPosition();
        if (pointer) {
          onRightClick(container.left + pointer.x, container.top + pointer.y);
        }
      }}
    >
      {/* Background circle */}
      <Circle
        radius={22}
        fill="rgba(255,255,255,0.9)"
        stroke="#374151"
        strokeWidth={2}
      />
      {/* North arrow */}
      <Arrow
        points={[0, 10, 0, -16]}
        fill="#dc2626"
        stroke="#dc2626"
        strokeWidth={2}
        pointerLength={6}
        pointerWidth={6}
      />
      {/* "N" label */}
      <Text
        text="N"
        x={-5}
        y={-15}
        fontSize={10}
        fontStyle="bold"
        fill="#dc2626"
      />
    </Group>
  );
}
