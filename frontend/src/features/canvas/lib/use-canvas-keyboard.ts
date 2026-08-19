"use client";

import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import { GRID_SIZE } from "./geometry";
import { getSlotLabel, type Slot, type StandGeometry } from "./types";

/** One grid square per arrow press; Shift covers ground faster. */
export const NUDGE_STEP = GRID_SIZE;
export const NUDGE_STEP_LARGE = GRID_SIZE * 3;

/**
 * A stand or a placed hive, addressable from the keyboard. Konva shapes are
 * not DOM nodes, so the canvas keeps its own roving focus over this list
 * instead of relying on the browser's tab order.
 */
export type CanvasFocusItem =
  | { id: string; kind: "stand"; standId: string; label: string }
  | {
      id: string;
      kind: "hive";
      standId: string;
      hiveId: string;
      row: number;
      col: number;
      label: string;
    };

interface CanvasKeyboardOptions {
  stands: StandGeometry[];
  slotsByStand: ReadonlyMap<string, Slot[]>;
  hiveLabelById: ReadonlyMap<string, string>;
  /** Role-derived: viewers get navigation and open, never mutation. */
  canEdit: boolean;
  editMode: boolean;
  onNudgeStand: (standId: string, dx: number, dy: number) => void;
  onActivate: (item: CanvasFocusItem) => void;
  onDelete: (item: CanvasFocusItem) => void;
}

/** Flatten stands and their placed hives into one stable navigation order. */
export function buildFocusItems(
  stands: StandGeometry[],
  slotsByStand: ReadonlyMap<string, Slot[]>,
  hiveLabelById: ReadonlyMap<string, string>,
): CanvasFocusItem[] {
  const items: CanvasFocusItem[] = [];
  for (const stand of stands) {
    items.push({
      id: `stand:${stand.id}`,
      kind: "stand",
      standId: stand.id,
      label: `Stand ${stand.label}`,
    });
    const slots = [...(slotsByStand.get(stand.id) ?? [])].sort(
      (a, b) => a.row - b.row || a.col - b.col,
    );
    for (const slot of slots) {
      for (const hive of slot.hives) {
        items.push({
          id: `hive:${hive.hiveId}`,
          kind: "hive",
          standId: stand.id,
          hiveId: hive.hiveId,
          row: slot.row,
          col: slot.col,
          label:
            hiveLabelById.get(hive.hiveId) ??
            getSlotLabel(stand.label, slot.row, slot.col, stand.cols),
        });
      }
    }
  }
  return items;
}

function describe(
  item: CanvasFocusItem,
  index: number,
  total: number,
  stands: StandGeometry[],
): string {
  const position = `${index + 1} of ${total}`;
  if (item.kind === "stand") {
    const stand = stands.find((s) => s.id === item.standId);
    const size = stand ? `, ${stand.rows} by ${stand.cols} slots` : "";
    return `${item.label}${size}. Item ${position}.`;
  }
  const stand = stands.find((s) => s.id === item.standId);
  const slot = stand
    ? getSlotLabel(stand.label, item.row, item.col, stand.cols)
    : `row ${item.row + 1} column ${item.col + 1}`;
  return `Hive ${item.label}, slot ${slot}${
    stand ? ` on stand ${stand.label}` : ""
  }. Item ${position}.`;
}

const ARROW_DELTA: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

/**
 * Keyboard path for the layout canvas: roving focus over stands and hives,
 * arrow-key nudging of the focused stand, and Enter/Delete wired to the same
 * actions the pointer reaches through the context menu.
 *
 * Only keys that land on the stage container itself are handled — nothing is
 * registered globally, so this cannot collide with the app-wide shortcut
 * registry (`g` chords, single-letter page actions, Ctrl/⌘K).
 */
export function useCanvasKeyboard({
  stands,
  slotsByStand,
  hiveLabelById,
  canEdit,
  editMode,
  onNudgeStand,
  onActivate,
  onDelete,
}: CanvasKeyboardOptions) {
  const items = useMemo(
    () => buildFocusItems(stands, slotsByStand, hiveLabelById),
    [stands, slotsByStand, hiveLabelById],
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const focusedIndex = focusedId
    ? items.findIndex((item) => item.id === focusedId)
    : -1;
  const focusedItem = focusedIndex >= 0 ? items[focusedIndex] : null;

  const clearFocus = useCallback(() => {
    setFocusedId(null);
    setAnnouncement("");
  }, []);

  const focusAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      setFocusedId(item.id);
      setAnnouncement(describe(item, index, items.length, stands));
    },
    [items, stands],
  );

  /** Returns false when the move would run off either end (Tab escapes then). */
  const moveFocus = useCallback(
    (delta: number, wrap: boolean) => {
      if (items.length === 0) return false;
      if (focusedIndex < 0) {
        focusAt(delta > 0 ? 0 : items.length - 1);
        return true;
      }
      const next = focusedIndex + delta;
      if (next < 0 || next >= items.length) {
        if (!wrap) return false;
        focusAt((next + items.length) % items.length);
        return true;
      }
      focusAt(next);
      return true;
    },
    [items, focusedIndex, focusAt],
  );

  const canMutate = canEdit && editMode;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Leaflet's map pane, the toolbar, and the context menu are all focusable
      // descendants with their own key handling — only act on the stage itself.
      if (event.target !== event.currentTarget) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key;

      if (key === "Escape") {
        event.preventDefault();
        if (focusedId) {
          clearFocus();
          setAnnouncement("Selection cleared.");
          return;
        }
        event.currentTarget.blur();
        return;
      }

      if (items.length === 0) return;

      if (key === "Tab") {
        if (moveFocus(event.shiftKey ? -1 : 1, false)) event.preventDefault();
        return;
      }

      const arrow = ARROW_DELTA[key];
      if (arrow) {
        event.preventDefault();
        if (focusedItem?.kind === "stand" && canMutate) {
          const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
          onNudgeStand(focusedItem.standId, arrow.dx * step, arrow.dy * step);
          setAnnouncement(
            `${focusedItem.label} moved ${key.replace("Arrow", "").toLowerCase()} ${step} units.`,
          );
          return;
        }
        moveFocus(arrow.dx + arrow.dy > 0 ? 1 : -1, true);
        return;
      }

      if (key === "Enter" || key === " ") {
        if (!focusedItem) return;
        event.preventDefault();
        onActivate(focusedItem);
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        if (!focusedItem || !canMutate) return;
        event.preventDefault();
        onDelete(focusedItem);
      }
    },
    [
      items.length,
      focusedId,
      focusedItem,
      canMutate,
      clearFocus,
      moveFocus,
      onActivate,
      onDelete,
      onNudgeStand,
    ],
  );

  const instructions = canEdit
    ? "Apiary layout canvas. Press Tab or the arrow keys to move between stands and hives. In edit mode the arrow keys move the focused stand by one grid square, or three with Shift. Press Enter or Space for the actions menu, Delete to remove the focused item, and Escape to clear the selection."
    : "Apiary layout canvas, view only. Press Tab or the arrow keys to move between stands and hives, Enter or Space to open the focused hive, and Escape to clear the selection.";

  return {
    items,
    focusedItem,
    announcement,
    instructions,
    handleKeyDown,
    clearFocus,
  };
}
