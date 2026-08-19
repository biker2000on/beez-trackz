"use client";

import { useCallback, useReducer } from "react";

import {
  createStandGeometry,
  getNextStandLabel,
  STAND_MAX_DIM,
  STAND_MIN_DIM,
  type CanvasMapView,
  type CanvasRegistration,
  type NorthArrowState,
  type StandGeometry,
} from "./types";

interface LayoutState {
  stands: StandGeometry[];
  northArrow: NorthArrowState;
  registration: CanvasRegistration | undefined;
  mapView: CanvasMapView | undefined;
  dirty: boolean;
  /** Increments on every edit; lets a completing save detect newer edits. */
  generation: number;
}

export type LayoutAction =
  | {
      type: "addStand";
      rows: number;
      cols: number;
      x: number;
      y: number;
      latitude?: number;
      longitude?: number;
    }
  | {
      type: "moveStand";
      standId: string;
      x: number;
      y: number;
      latitude?: number;
      longitude?: number;
    }
  | { type: "hydrateStands"; stands: StandGeometry[]; dirty?: boolean }
  | { type: "rotateStand"; standId: string; rotation: number }
  | { type: "configureStand"; standId: string; label: string; rows: number; cols: number }
  | { type: "deleteStand"; standId: string }
  | { type: "moveNorthArrow"; x: number; y: number }
  | { type: "rotateNorthArrow"; rotation: number }
  | { type: "setRegistration"; registration: CanvasRegistration }
  | { type: "setMapView"; mapView: CanvasMapView }
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
        action.latitude != null && action.longitude != null
          ? { latitude: action.latitude, longitude: action.longitude }
          : undefined,
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
        latitude: action.latitude ?? s.latitude,
        longitude: action.longitude ?? s.longitude,
      }));
    case "hydrateStands":
      return {
        ...state,
        stands: action.stands,
        dirty: action.dirty ?? true,
        generation: action.dirty === false ? state.generation : state.generation + 1,
      };
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
    case "setRegistration":
      return {
        ...state,
        registration: action.registration,
        dirty: true,
        generation: state.generation + 1,
      };
    case "setMapView": {
      // Leaflet's moveend republishes a pixel-rounded centre on mount; don't
      // mark the layout dirty for sub-centimetre drift.
      const prev = state.mapView;
      if (
        prev &&
        prev.zoom === action.mapView.zoom &&
        Math.abs(prev.centerLat - action.mapView.centerLat) < 1e-7 &&
        Math.abs(prev.centerLng - action.mapView.centerLng) < 1e-7
      ) {
        return state;
      }
      return {
        ...state,
        mapView: action.mapView,
        dirty: true,
        generation: state.generation + 1,
      };
    }
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
  registration?: CanvasRegistration;
  mapView?: CanvasMapView;
}) {
  const [state, dispatch] = useReducer(reducer, {
    stands: initial.stands,
    northArrow: initial.northArrow ?? { x: 40, y: 40, rotation: 0 },
    registration: initial.registration,
    mapView: initial.mapView,
    dirty: false,
    generation: 0,
  });

  const markSaved = useCallback(
    (generation: number) => dispatch({ type: "markSaved", generation }),
    [],
  );

  return { ...state, dispatch, markSaved };
}
