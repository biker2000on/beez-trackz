"use client";

import { useCallback, useReducer } from "react";

import {
  createStandGeometry,
  getNextStandLabel,
  STAND_MAX_DIM,
  STAND_MIN_DIM,
  type NorthArrowState,
  type StandGeometry,
} from "./types";

interface LayoutState {
  stands: StandGeometry[];
  northArrow: NorthArrowState;
  dirty: boolean;
  /** Increments on every edit; lets a completing save detect newer edits. */
  generation: number;
}

export type LayoutAction =
  | { type: "addStand"; rows: number; cols: number; x: number; y: number }
  | { type: "moveStand"; standId: string; x: number; y: number }
  | { type: "rotateStand"; standId: string; rotation: number }
  | { type: "configureStand"; standId: string; label: string; rows: number; cols: number }
  | { type: "deleteStand"; standId: string }
  | { type: "moveNorthArrow"; x: number; y: number }
  | { type: "rotateNorthArrow"; rotation: number }
  | { type: "markViewportDirty" }
  | { type: "markSaved"; generation: number };

const clampDim = (n: number) =>
  Math.max(STAND_MIN_DIM, Math.min(STAND_MAX_DIM, Math.round(n)));

function updateStand(
  state: LayoutState,
  standId: string,
  patch: (stand: StandGeometry) => StandGeometry,
): LayoutState {
  return {
    ...state,
    stands: state.stands.map((s) => (s.id === standId ? patch(s) : s)),
    dirty: true,
    generation: state.generation + 1,
  };
}

function reducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case "addStand": {
      const label = getNextStandLabel(state.stands);
      const stand = createStandGeometry(
        label,
        clampDim(action.rows),
        clampDim(action.cols),
        action.x,
        action.y,
      );
      return {
        ...state,
        stands: [...state.stands, stand],
        dirty: true,
        generation: state.generation + 1,
      };
    }
    case "moveStand":
      return updateStand(state, action.standId, (s) => ({
        ...s,
        x: action.x,
        y: action.y,
      }));
    case "rotateStand":
      return updateStand(state, action.standId, (s) => ({
        ...s,
        rotation: action.rotation,
      }));
    case "configureStand":
      return updateStand(state, action.standId, (s) => ({
        ...s,
        label: action.label,
        rows: clampDim(action.rows),
        cols: clampDim(action.cols),
      }));
    case "deleteStand":
      return {
        ...state,
        stands: state.stands.filter((s) => s.id !== action.standId),
        dirty: true,
        generation: state.generation + 1,
      };
    case "moveNorthArrow":
      return {
        ...state,
        northArrow: { ...state.northArrow, x: action.x, y: action.y },
        dirty: true,
        generation: state.generation + 1,
      };
    case "rotateNorthArrow":
      return {
        ...state,
        northArrow: { ...state.northArrow, rotation: action.rotation },
        dirty: true,
        generation: state.generation + 1,
      };
    case "markViewportDirty":
      // Zoom/pan is part of the saved blob; persist it via the same
      // dirty/autosave path as geometry edits.
      return { ...state, dirty: true, generation: state.generation + 1 };
    case "markSaved":
      // Only clear dirty when no edits landed while the save was in flight —
      // otherwise those edits would never autosave.
      return state.dirty && state.generation === action.generation
        ? { ...state, dirty: false }
        : state;
  }
}

/**
 * Stand + north-arrow geometry with a dirty flag. Edits stay local until
 * persisted (explicit Save button or the debounced autosave).
 */
export function useLayoutState(initial: {
  stands: StandGeometry[];
  northArrow?: NorthArrowState;
}) {
  const [state, dispatch] = useReducer(reducer, {
    stands: initial.stands,
    northArrow: initial.northArrow ?? { x: 40, y: 40, rotation: 0 },
    dirty: false,
    generation: 0,
  });

  const markSaved = useCallback(
    (generation: number) => dispatch({ type: "markSaved", generation }),
    [],
  );

  return { ...state, dispatch, markSaved };
}
