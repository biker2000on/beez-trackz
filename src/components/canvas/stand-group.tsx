"use client";

import { Group, Rect, Text, Arrow, Line } from "react-konva";
import type { Stand, SlotHive, HivePlacement } from "@/lib/canvas/types";
import { getSlotLabel } from "@/lib/canvas/types";

const CELL_SIZE = 60;
const CELL_PADDING = 4;
const HIVE_COLORS: Record<string, string> = {
  active: "#4A7C32",
  dead: "#8B4513",
  sold: "#4682B4",
  combined: "#DAA520",
};
const DEFAULT_HIVE_COLOR = "#888";

interface StandGroupProps {
  stand: Stand;
  hiveStatusMap: Record<string, string>; // hiveId -> status
  hiveLabelMap: Record<string, string>; // hiveId -> positionLabel
  editMode: boolean;
  onStandDragEnd: (standId: string, x: number, y: number) => void;
  onHiveRightClick: (hiveId: string, screenX: number, screenY: number) => void;
  onSlotRightClick: (standId: string, row: number, col: number, screenX: number, screenY: number) => void;
  onStandRightClick: (standId: string, screenX: number, screenY: number) => void;
  onHiveDoubleTap: (hiveId: string) => void;
}

function getDirectionArrow(facingDegrees: number, cx: number, cy: number, size: number) {
  const rad = (facingDegrees - 90) * (Math.PI / 180);
  const len = size * 0.35;
  const endX = cx + Math.cos(rad) * len;
  const endY = cy + Math.sin(rad) * len;
  return { startX: cx, startY: cy, endX, endY };
}

function getPlacementRect(
  placement: HivePlacement,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number
): { x: number; y: number; w: number; h: number } {
  const p = CELL_PADDING;
  switch (placement) {
    case "full":
      return { x: cellX + p, y: cellY + p, w: cellW - p * 2, h: cellH - p * 2 };
    case "top":
      return { x: cellX + p, y: cellY + p, w: cellW - p * 2, h: cellH / 2 - p * 1.5 };
    case "bottom":
      return { x: cellX + p, y: cellY + cellH / 2 + p * 0.5, w: cellW - p * 2, h: cellH / 2 - p * 1.5 };
    case "left":
      return { x: cellX + p, y: cellY + p, w: cellW / 2 - p * 1.5, h: cellH - p * 2 };
    case "right":
      return { x: cellX + cellW / 2 + p * 0.5, y: cellY + p, w: cellW / 2 - p * 1.5, h: cellH - p * 2 };
    case "third-1":
      return { x: cellX + p, y: cellY + p, w: cellW / 3 - p, h: cellH - p * 2 };
    case "third-2":
      return { x: cellX + cellW / 3 + p * 0.5, y: cellY + p, w: cellW / 3 - p, h: cellH - p * 2 };
    case "third-3":
      return { x: cellX + (cellW * 2) / 3 + p * 0.5, y: cellY + p, w: cellW / 3 - p, h: cellH - p * 2 };
  }
}

function HiveIndicator({
  hive,
  cellX,
  cellY,
  cellW,
  cellH,
  status,
  label,
  onRightClick,
  onDoubleTap,
}: {
  hive: SlotHive;
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
  status: string;
  label: string;
  onRightClick: (hiveId: string, screenX: number, screenY: number) => void;
  onDoubleTap: (hiveId: string) => void;
}) {
  const rect = getPlacementRect(hive.placement, cellX, cellY, cellW, cellH);
  const color = HIVE_COLORS[status] || DEFAULT_HIVE_COLOR;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const arrow = getDirectionArrow(hive.facingDegrees, cx, cy, Math.min(rect.w, rect.h));

  return (
    <>
      <Rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={color}
        opacity={0.8}
        cornerRadius={3}
        onContextMenu={(e) => {
          e.evt.preventDefault();
          const stage = e.target.getStage();
          if (!stage) return;
          const container = stage.container().getBoundingClientRect();
          const pointer = stage.getPointerPosition();
          if (pointer) {
            onRightClick(hive.hiveId, container.left + pointer.x, container.top + pointer.y);
          }
        }}
        onDblClick={() => onDoubleTap(hive.hiveId)}
        onDblTap={() => onDoubleTap(hive.hiveId)}
      />
      <Arrow
        points={[arrow.startX, arrow.startY, arrow.endX, arrow.endY]}
        fill="white"
        stroke="white"
        strokeWidth={1.5}
        pointerLength={4}
        pointerWidth={4}
        listening={false}
      />
      {hive.placement === "full" && (
        <Text
          x={rect.x}
          y={rect.y + rect.h - 14}
          width={rect.w}
          text={label}
          fontSize={9}
          fill="white"
          align="center"
          listening={false}
        />
      )}
    </>
  );
}

export function StandGroup({
  stand,
  hiveStatusMap,
  hiveLabelMap,
  editMode,
  onStandDragEnd,
  onHiveRightClick,
  onSlotRightClick,
  onStandRightClick,
  onHiveDoubleTap,
}: StandGroupProps) {
  const totalW = stand.cols * CELL_SIZE;
  const totalH = stand.rows * CELL_SIZE;
  const labelHeight = 20;

  return (
    <Group
      x={stand.x}
      y={stand.y}
      rotation={stand.rotation}
      draggable={editMode}
      onDragEnd={(e) => {
        onStandDragEnd(stand.id, e.target.x(), e.target.y());
      }}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        const stage = e.target.getStage();
        if (!stage) return;
        const container = stage.container().getBoundingClientRect();
        const pointer = stage.getPointerPosition();
        if (pointer) {
          onStandRightClick(stand.id, container.left + pointer.x, container.top + pointer.y);
        }
      }}
    >
      {/* Stand label */}
      <Text
        x={0}
        y={-labelHeight}
        width={totalW}
        text={`Stand ${stand.label}`}
        fontSize={12}
        fontStyle="bold"
        fill="#5C3A1E"
        align="center"
        listening={false}
      />

      {/* Stand background */}
      <Rect
        x={0}
        y={0}
        width={totalW}
        height={totalH}
        fill="#F5E6D0"
        stroke="#8B6914"
        strokeWidth={1.5}
        cornerRadius={4}
        opacity={0.6}
      />

      {/* Grid lines */}
      {Array.from({ length: stand.cols - 1 }).map((_, i) => (
        <Line
          key={`v${i}`}
          points={[(i + 1) * CELL_SIZE, 0, (i + 1) * CELL_SIZE, totalH]}
          stroke="#8B6914"
          strokeWidth={0.5}
          opacity={0.4}
          listening={false}
        />
      ))}
      {Array.from({ length: stand.rows - 1 }).map((_, i) => (
        <Line
          key={`h${i}`}
          points={[0, (i + 1) * CELL_SIZE, totalW, (i + 1) * CELL_SIZE]}
          stroke="#8B6914"
          strokeWidth={0.5}
          opacity={0.4}
          listening={false}
        />
      ))}

      {/* Slots */}
      {stand.slots.map((slot) => {
        const cellX = slot.col * CELL_SIZE;
        const cellY = slot.row * CELL_SIZE;
        const slotLabel = getSlotLabel(stand.label, slot.row, slot.col, stand.cols);

        return (
          <Group key={`${slot.row}-${slot.col}`}>
            {/* Click target for empty slots */}
            <Rect
              x={cellX}
              y={cellY}
              width={CELL_SIZE}
              height={CELL_SIZE}
              fill="transparent"
              onContextMenu={(e) => {
                e.evt.preventDefault();
                if (slot.hives.length === 0) {
                  const stage = e.target.getStage();
                  if (!stage) return;
                  const container = stage.container().getBoundingClientRect();
                  const pointer = stage.getPointerPosition();
                  if (pointer) {
                    onSlotRightClick(stand.id, slot.row, slot.col, container.left + pointer.x, container.top + pointer.y);
                  }
                }
              }}
            />

            {/* Slot label for empty slots */}
            {slot.hives.length === 0 && (
              <Text
                x={cellX}
                y={cellY + CELL_SIZE / 2 - 6}
                width={CELL_SIZE}
                text={slotLabel}
                fontSize={10}
                fill="#999"
                align="center"
                listening={false}
              />
            )}

            {/* Hive indicators */}
            {slot.hives.map((hive) => (
              <HiveIndicator
                key={hive.hiveId}
                hive={hive}
                cellX={cellX}
                cellY={cellY}
                cellW={CELL_SIZE}
                cellH={CELL_SIZE}
                status={hiveStatusMap[hive.hiveId] || "active"}
                label={hiveLabelMap[hive.hiveId] || slotLabel}
                onRightClick={onHiveRightClick}
                onDoubleTap={onHiveDoubleTap}
              />
            ))}
          </Group>
        );
      })}
    </Group>
  );
}
