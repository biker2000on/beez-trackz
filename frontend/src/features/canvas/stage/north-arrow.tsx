"use client";

import type Konva from "konva";
import { Arrow, Circle, Group, Text } from "react-konva";

interface NorthArrowProps {
  x: number;
  y: number;
  rotation: number;
  draggable: boolean;
  onDragEnd: (x: number, y: number) => void;
  onRightClick: (screenX: number, screenY: number) => void;
  /** Called with `true` while the user holds the rotate handle. */
  onRotateHandleDown: () => void;
}

/**
 * Draggable north-direction widget. Rotation happens via the orbit handle
 * (edit mode) or the right-click preset menu.
 */
export function NorthArrow({
  x,
  y,
  rotation,
  draggable,
  onDragEnd,
  onRightClick,
  onRotateHandleDown,
}: NorthArrowProps) {
  const handleContextMenu = (e: Konva.KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    e.cancelBubble = true;
    const stage = e.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const rect = stage.container().getBoundingClientRect();
    onRightClick(rect.left + pointer.x, rect.top + pointer.y);
  };

  const rad = rotation * (Math.PI / 180);
  const handleDist = 36;
  const hx = Math.sin(rad) * handleDist;
  const hy = -Math.cos(rad) * handleDist;

  return (
    <Group
      x={x}
      y={y}
      draggable={draggable}
      onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y())}
      onContextMenu={handleContextMenu}
    >
      <Group rotation={rotation}>
        <Circle radius={22} fill="rgba(255,255,255,0.9)" stroke="#374151" strokeWidth={2} />
        <Arrow
          points={[0, 10, 0, -16]}
          fill="#dc2626"
          stroke="#dc2626"
          strokeWidth={2}
          pointerLength={6}
          pointerWidth={6}
        />
        <Text text="N" x={-5} y={-15} fontSize={10} fontStyle="bold" fill="#dc2626" />
      </Group>
      {draggable && (
        <Circle
          x={hx}
          y={hy}
          radius={6}
          fill="#f59e0b"
          stroke="#b45309"
          strokeWidth={1.5}
          onMouseDown={(e) => {
            e.cancelBubble = true;
            onRotateHandleDown();
          }}
          onTouchStart={(e) => {
            e.cancelBubble = true;
            onRotateHandleDown();
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
      )}
    </Group>
  );
}
