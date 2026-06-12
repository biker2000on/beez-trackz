"use client";

import { useCallback, useReducer } from "react";
import type { StandGeometry } from "@/lib/canvas/types";
import { createStandGeometry, getNextStandLabel } from "@/lib/canvas/types";

interface GeometryState {
  stands: StandGeometry[];
  northArrow: { x: number; y: number; rotation: number };
  dirty: boolean;
}

type GeometryAction =
  | { type: "addStand"; rows: number; cols: number; x: number; y: number }
  | { type: "moveStand"; standId: string; x: number; y: number }
  | { type: "rotateStand"; standId: string; rotation: number }
  | { type: "resizeStand"; standId: string; rows: number; cols: number }
  | { type: "renameStand"; standId: string; label: string }
  | { type: "deleteStand"; standId: string }
  | { type: "moveNorthArrow"; x: number; y: number }
  | { type: "rotateNorthArrow"; rotation: number }
  | { type: "markSaved" };

function reducer(state: GeometryState, action: GeometryAction): GeometryState {
  switch (action.type) {
    case "addStand": {
      const label = getNextStandLabel(state.stands);
      const stand = createStandGeometry(label, action.rows, action.cols, action.x, action.y);
      return { ...state, stands: [...state.stands, stand], dirty: true };
    }
    case "moveStand":
      return {
        ...state,
        stands: state.stands.map((s) =>
          s.id === action.standId ? { ...s, x: action.x, y: action.y } : s
        ),
        dirty: true,
      };
    case "rotateStand":
      return {
        ...state,
        stands: state.stands.map((s) =>
          s.id === action.standId ? { ...s, rotation: action.rotation } : s
        ),
        dirty: true,
      };
    case "resizeStand":
      return {
        ...state,
        stands: state.stands.map((s) =>
          s.id === action.standId
            ? {
                ...s,
                rows: Math.max(1, Math.min(8, action.rows)),
                cols: Math.max(1, Math.min(8, action.cols)),
              }
            : s
        ),
        dirty: true,
      };
    case "renameStand":
      return {
        ...state,
        stands: state.stands.map((s) =>
          s.id === action.standId ? { ...s, label: action.label } : s
        ),
        dirty: true,
      };
    case "deleteStand":
      return {
        ...state,
        stands: state.stands.filter((s) => s.id !== action.standId),
        dirty: true,
      };
    case "moveNorthArrow":
      return { ...state, northArrow: { ...state.northArrow, x: action.x, y: action.y }, dirty: true };
    case "rotateNorthArrow":
      return { ...state, northArrow: { ...state.northArrow, rotation: action.rotation }, dirty: true };
    case "markSaved":
      return { ...state, dirty: false };
  }
}

/** Stand/north-arrow geometry edits with a dirty flag for explicit Save. */
export function useStandGeometry(initial: {
  stands: StandGeometry[];
  northArrow?: { x: number; y: number; rotation: number };
}) {
  const [state, dispatch] = useReducer(reducer, {
    stands: initial.stands,
    northArrow: initial.northArrow ?? { x: 40, y: 40, rotation: 0 },
    dirty: false,
  });

  const markSaved = useCallback(() => dispatch({ type: "markSaved" }), []);

  return { ...state, dispatch, markSaved };
}
