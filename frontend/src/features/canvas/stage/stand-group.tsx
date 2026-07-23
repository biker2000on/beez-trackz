"use client";

import { memo } from "react";
import type Konva from "konva";
import { Arrow, Group, Line, Rect, Text } from "react-konva";

import { CELL_SIZE, facingArrow, placementRect } from "../lib/geometry";
import { getSlotLabel, type Slot, type SlotHive, type StandGeometry } from "../lib/types";

const HIVE_COLORS: Record<string, string> = {
  active: "#4a7c32",
  dead: "#8b4513",
  sold: "#4682b4",
  combined: "#daa520",
};
const DEFAULT_HIVE_COLOR = "#888888";

/** Screen-coordinate pointer position for anchoring DOM context menus. */
function pointerScreenPosition(
  e: Konva.KonvaEventObject<Event>,
): { x: number; y: number } | null {
  const stage = e.target.getStage();
  const pointer = stage?.getPointerPosition();
  if (!stage || !pointer) return null;
  const rect = stage.container().getBoundingClientRect();
  return { x: rect.left + pointer.x, y: rect.top + pointer.y };
}

/** World-coordinate pointer position (undoes stage pan/zoom). */
function pointerWorldPosition(
  e: Konva.KonvaEventObject<Event>,
): { x: number; y: number } | null {
  const stage = e.target.getStage();
  const pointer = stage?.getPointerPosition();
  if (!stage || !pointer) return null;
  return {
    x: (pointer.x - stage.x()) / stage.scaleX(),
    y: (pointer.y - stage.y()) / stage.scaleY(),
  };
}

interface HiveNodeProps {
  hive: SlotHive;
  cellX: number;
  cellY: number;
  status: string;
  label: string;
  editMode: boolean;
  isDragging: boolean;
  onRightClick: (hiveId: string, screenX: number, screenY: number) => void;
  onOpen: (hiveId: string) => void;
  onDragStart: (hiveId: string) => void;
  onDragMove: (hiveId: string, worldX: number, worldY: number) => void;
  onDragEnd: (hiveId: string) => void;
}

function HiveNode({
  hive,
  cellX,
  cellY,
  status,
  label,
  editMode,
  isDragging,
  onRightClick,
  onOpen,
  onDragStart,
  onDragMove,
  onDragEnd,
}: HiveNodeProps) {
  const rect = placementRect(hive.placement, cellX, cellY, CELL_SIZE, CELL_SIZE);
  const color = HIVE_COLORS[status] ?? DEFAULT_HIVE_COLOR;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const arrow = facingArrow(hive.facingDegrees, cx, cy, Math.min(rect.w, rect.h));
  const arrowPointsDown = arrow.endY > arrow.startY;

  return (
    <>
      <Rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={color}
        opacity={isDragging ? 0.3 : 0.85}
        cornerRadius={3}
        draggable={editMode}
        onDragStart={(e) => {
          e.cancelBubble = true;
          onDragStart(hive.hiveId);
        }}
        onDragMove={(e) => {
          e.cancelBubble = true;
          const world = pointerWorldPosition(e);
          if (world) onDragMove(hive.hiveId, world.x, world.y);
        }}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          // Snap the ghost back; the authoritative position re-renders from
          // the hives query after the write-through completes.
          e.target.position({ x: rect.x, y: rect.y });
          onDragEnd(hive.hiveId);
        }}
        onContextMenu={(e) => {
          e.evt.preventDefault();
          e.cancelBubble = true;
          const screen = pointerScreenPosition(e);
          if (screen) onRightClick(hive.hiveId, screen.x, screen.y);
        }}
        onDblClick={() => onOpen(hive.hiveId)}
        onDblTap={() => onOpen(hive.hiveId)}
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
          y={arrowPointsDown ? rect.y + 2 : rect.y + rect.h - 14}
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

export interface DragOverSlot {
  standId: string;
  row: number;
  col: number;
  canDrop: boolean;
  willStack: boolean;
}

interface StandGroupProps {
  stand: StandGeometry;
  slots: Slot[];
  hiveStatusById: ReadonlyMap<string, string>;
  hiveLabelById: ReadonlyMap<string, string>;
  editMode: boolean;
  isRotating: boolean;
  draggingHiveId: string | null;
  dragOverSlot: DragOverSlot | null;
  onStandDragEnd: (standId: string, x: number, y: number) => void;
  onStandRightClick: (standId: string, screenX: number, screenY: number) => void;
  onSlotRightClick: (
    standId: string,
    row: number,
    col: number,
    screenX: number,
    screenY: number,
  ) => void;
  onHiveRightClick: (hiveId: string, screenX: number, screenY: number) => void;
  onHiveOpen: (hiveId: string) => void;
  onHiveDragStart: (hiveId: string) => void;
  onHiveDragMove: (hiveId: string, worldX: number, worldY: number) => void;
  onHiveDragEnd: (hiveId: string) => void;
}

function StandGroupInner({
  stand,
  slots,
  hiveStatusById,
  hiveLabelById,
  editMode,
  isRotating,
  draggingHiveId,
  dragOverSlot,
  onStandDragEnd,
  onStandRightClick,
  onSlotRightClick,
  onHiveRightClick,
  onHiveOpen,
  onHiveDragStart,
  onHiveDragMove,
  onHiveDragEnd,
}: StandGroupProps) {
  const totalW = stand.cols * CELL_SIZE;
  const totalH = stand.rows * CELL_SIZE;

  return (
    <Group
      x={stand.x + totalW / 2}
      y={stand.y + totalH / 2}
      offsetX={totalW / 2}
      offsetY={totalH / 2}
      rotation={stand.rotation}
      draggable={editMode && !isRotating}
      onDragEnd={(e) => {
        onStandDragEnd(stand.id, e.target.x() - totalW / 2, e.target.y() - totalH / 2);
      }}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        const screen = pointerScreenPosition(e);
        if (screen) onStandRightClick(stand.id, screen.x, screen.y);
      }}
    >
      {/* Stand label */}
      <Text
        x={0}
        y={-20}
        width={totalW}
        text={`Stand ${stand.label}`}
        fontSize={12}
        fontStyle="bold"
        fill="#5c3a1e"
        align="center"
        listening={false}
      />

      {/* Stand background */}
      <Rect
        x={0}
        y={0}
        width={totalW}
        height={totalH}
        fill="#f5e6d0"
        stroke="#8b6914"
        strokeWidth={1.5}
        cornerRadius={4}
        opacity={0.6}
      />

      {/* Interior grid lines */}
      {Array.from({ length: stand.cols - 1 }, (_, i) => (
        <Line
          key={`v${i}`}
          points={[(i + 1) * CELL_SIZE, 0, (i + 1) * CELL_SIZE, totalH]}
          stroke="#8b6914"
          strokeWidth={0.5}
          opacity={0.4}
          listening={false}
        />
      ))}
      {Array.from({ length: stand.rows - 1 }, (_, i) => (
        <Line
          key={`h${i}`}
          points={[0, (i + 1) * CELL_SIZE, totalW, (i + 1) * CELL_SIZE]}
          stroke="#8b6914"
          strokeWidth={0.5}
          opacity={0.4}
          listening={false}
        />
      ))}

      {/* Slots */}
      {slots.map((slot) => {
        const cellX = slot.col * CELL_SIZE;
        const cellY = slot.row * CELL_SIZE;
        const slotLabel = getSlotLabel(stand.label, slot.row, slot.col, stand.cols);
        const highlight =
          dragOverSlot &&
          dragOverSlot.standId === stand.id &&
          dragOverSlot.row === slot.row &&
          dragOverSlot.col === slot.col
            ? dragOverSlot
            : null;

        return (
          <Group key={`${slot.row}-${slot.col}`}>
            {/* Right-click target for the cell */}
            <Rect
              x={cellX}
              y={cellY}
              width={CELL_SIZE}
              height={CELL_SIZE}
              fill="transparent"
              onContextMenu={(e) => {
                e.evt.preventDefault();
                e.cancelBubble = true;
                const screen = pointerScreenPosition(e);
                if (screen) {
                  onSlotRightClick(stand.id, slot.row, slot.col, screen.x, screen.y);
                }
              }}
            />

            {/* Live can-drop highlight while dragging a hive */}
            {highlight && (
              <Rect
                x={cellX + 2}
                y={cellY + 2}
                width={CELL_SIZE - 4}
                height={CELL_SIZE - 4}
                fill="transparent"
                stroke={
                  highlight.canDrop
                    ? highlight.willStack
                      ? "#22c55e"
                      : "#3b82f6"
                    : "#ef4444"
                }
                strokeWidth={2}
                dash={[4, 4]}
                cornerRadius={3}
                listening={false}
              />
            )}

            {/* Slot label for empty slots */}
            {slot.hives.length === 0 && (
              <Text
                x={cellX}
                y={cellY + CELL_SIZE / 2 - 6}
                width={CELL_SIZE}
                text={slotLabel}
                fontSize={10}
                fill="#999999"
                align="center"
                listening={false}
              />
            )}

            {slot.hives.map((hive) => (
              <HiveNode
                key={hive.hiveId}
                hive={hive}
                cellX={cellX}
                cellY={cellY}
                status={hiveStatusById.get(hive.hiveId) ?? "active"}
                label={hiveLabelById.get(hive.hiveId) ?? slotLabel}
                editMode={editMode}
                isDragging={draggingHiveId === hive.hiveId}
                onRightClick={onHiveRightClick}
                onOpen={onHiveOpen}
                onDragStart={onHiveDragStart}
                onDragMove={onHiveDragMove}
                onDragEnd={onHiveDragEnd}
              />
            ))}
          </Group>
        );
      })}
    </Group>
  );
}

export const StandGroup = memo(StandGroupInner);
