"use client";

import { useCallback } from "react";
import { Group, Rect, Text } from "react-konva";
import type Konva from "konva";

const STATUS_COLORS: Record<string, { fill: string; stroke: string }> = {
  active: { fill: "#f59e0b", stroke: "#d97706" },
  dead: { fill: "#9ca3af", stroke: "#6b7280" },
  sold: { fill: "#3b82f6", stroke: "#2563eb" },
  combined: { fill: "#a855f7", stroke: "#9333ea" },
};

const HIVE_WIDTH = 60;
const HIVE_HEIGHT = 50;

interface HiveIconProps {
  id: string;
  positionLabel: string;
  status: string;
  x: number;
  y: number;
  draggable: boolean;
  onDragEnd: (id: string, x: number, y: number) => void;
  onDoubleTap: (id: string) => void;
}

export function HiveIcon({
  id,
  positionLabel,
  status,
  x,
  y,
  draggable,
  onDragEnd,
  onDoubleTap,
}: HiveIconProps) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.active;

  const handleDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      onDragEnd(id, e.target.x(), e.target.y());
    },
    [id, onDragEnd]
  );

  const handleDoubleTap = useCallback(() => {
    onDoubleTap(id);
  }, [id, onDoubleTap]);

  // Truncate label if too long
  const displayLabel =
    positionLabel.length > 8
      ? positionLabel.substring(0, 7) + "..."
      : positionLabel;

  return (
    <Group
      x={x}
      y={y}
      draggable={draggable}
      onDragEnd={handleDragEnd}
      onDblClick={handleDoubleTap}
      onDblTap={handleDoubleTap}
    >
      {/* Hive body */}
      <Rect
        width={HIVE_WIDTH}
        height={HIVE_HEIGHT}
        fill={colors.fill}
        stroke={colors.stroke}
        strokeWidth={2}
        cornerRadius={4}
        shadowColor="rgba(0,0,0,0.2)"
        shadowBlur={4}
        shadowOffsetY={2}
      />
      {/* Roof detail */}
      <Rect
        y={0}
        width={HIVE_WIDTH}
        height={10}
        fill={colors.stroke}
        cornerRadius={[4, 4, 0, 0]}
      />
      {/* Label */}
      <Text
        text={displayLabel}
        width={HIVE_WIDTH}
        height={HIVE_HEIGHT - 10}
        y={12}
        align="center"
        verticalAlign="middle"
        fontSize={12}
        fontStyle="bold"
        fill="#ffffff"
      />
      {/* Status indicator dot */}
      <Text
        text={status === "active" ? "" : status.charAt(0).toUpperCase()}
        x={HIVE_WIDTH - 14}
        y={HIVE_HEIGHT - 14}
        fontSize={10}
        fill="#ffffff"
        fontStyle="bold"
      />
    </Group>
  );
}
