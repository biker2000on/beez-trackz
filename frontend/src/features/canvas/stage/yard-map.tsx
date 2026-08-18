"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  DEFAULT_TILE_LAYER,
  TILE_LAYERS,
  YARD_MAX_ZOOM,
  type TileLayerId,
} from "@/features/map/tile-layers";

import {
  overlayTransform,
  type CanvasMapView,
  type CanvasRegistration,
  type GeoOverlayTransform,
} from "../lib/geo";

interface YardMapProps {
  latitude: number;
  longitude: number;
  registration: CanvasRegistration;
  layerId: TileLayerId;
  imageryOpacity: number;
  locked: boolean;
  initialView?: CanvasMapView;
  onViewChange: (view: CanvasMapView) => void;
  onTransform: (transform: GeoOverlayTransform, map: LeafletMap) => void;
}

/**
 * Leaflet substrate under the Konva yard. Owns pan/zoom, including
 * overzoom past the last imagery tile so stands stay large enough to edit.
 * The Konva overlay is georeferenced via `onTransform`.
 */
export function YardMap({
  latitude,
  longitude,
  registration,
  layerId,
  imageryOpacity,
  locked,
  initialView,
  onViewChange,
  onTransform,
}: YardMapProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const tileRef = useRef<import("leaflet").TileLayer | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  const onTransformRef = useRef(onTransform);
  const registrationRef = useRef(registration);
  const pinRef = useRef({ lat: latitude, lng: longitude });

  useEffect(() => {
    onViewChangeRef.current = onViewChange;
    onTransformRef.current = onTransform;
    registrationRef.current = registration;
    pinRef.current = { lat: latitude, lng: longitude };
  }, [onViewChange, onTransform, registration, latitude, longitude]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let cancelled = false;
    let map: LeafletMap | null = null;

    void import("leaflet").then((mod) => {
      const L = mod.default;
      if (cancelled || !elRef.current) return;
      const start = initialView ?? {
        centerLat: latitude,
        centerLng: longitude,
        zoom: 19,
      };
      map = L.map(elRef.current, {
        center: [start.centerLat, start.centerLng],
        zoom: start.zoom,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        minZoom: 4,
        maxZoom: YARD_MAX_ZOOM,
        // Sibling Konva overlay is not in the map pane; CSS zoom
        // animation would slide tiles while the overlay snaps to target.
        zoomAnimation: false,
        markerZoomAnimation: false,
        zoomControl: false,
        attributionControl: true,
      });
      const def = TILE_LAYERS[layerId] ?? TILE_LAYERS[DEFAULT_TILE_LAYER];
      const tile = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxNativeZoom: def.maxNativeZoom,
        maxZoom: def.maxZoom,
        opacity: layerId === "imagery" ? imageryOpacity : 1,
      }).addTo(map);
      tileRef.current = tile;

      const publishTransform = () => {
        if (!map) return;
        onTransformRef.current(
          overlayTransform(map, pinRef.current, registrationRef.current),
          map,
        );
      };
      const publishView = () => {
        if (!map) return;
        const center = map.getCenter();
        onViewChangeRef.current({
          centerLat: center.lat,
          centerLng: center.lng,
          zoom: map.getZoom(),
        });
      };

      map.on("move zoom", publishTransform);
      map.on("moveend zoomend", () => {
        publishTransform();
        publishView();
      });
      publishTransform();
      requestAnimationFrame(() => map?.invalidateSize());
      mapRef.current = map;
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      tileRef.current = null;
    };
    // Mount once per pin. Layer/opacity/lock update in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void import("leaflet").then((mod) => {
      const L = mod.default;
      const def = TILE_LAYERS[layerId];
      if (tileRef.current) map.removeLayer(tileRef.current);
      const tile = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxNativeZoom: def.maxNativeZoom,
        maxZoom: def.maxZoom,
        opacity: layerId === "imagery" ? imageryOpacity : 1,
      }).addTo(map);
      tileRef.current = tile;
    });
  }, [layerId, imageryOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const toggle = (on: boolean) => {
      if (on) {
        map.dragging.enable();
        map.scrollWheelZoom.enable();
        map.touchZoom.enable();
        map.doubleClickZoom.enable();
        map.boxZoom.enable();
        map.keyboard.enable();
      } else {
        map.dragging.disable();
        map.scrollWheelZoom.disable();
        map.touchZoom.disable();
        map.doubleClickZoom.disable();
        map.boxZoom.disable();
        map.keyboard.disable();
      }
    };
    toggle(!locked);
  }, [locked]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    onTransform(
      overlayTransform(map, { lat: latitude, lng: longitude }, registration),
      map,
    );
  }, [registration, latitude, longitude, onTransform]);

  return (
    <div
      ref={elRef}
      className="absolute inset-0 z-0 [&_.leaflet-container]:h-full [&_.leaflet-container]:w-full [&_.leaflet-container]:bg-muted [&_.leaflet-container]:font-sans [&_.leaflet-control-attribution]:text-[10px]"
    />
  );
}

export function fitMapToStands(
  map: LeafletMap,
  corners: Array<{ lat: number; lng: number }>,
) {
  if (corners.length === 0) return;
  void import("leaflet").then((mod) => {
    const L = mod.default;
    const bounds = L.latLngBounds(corners.map((c) => [c.lat, c.lng] as [number, number]));
    map.fitBounds(bounds.pad(0.35), { animate: false, maxZoom: YARD_MAX_ZOOM });
  });
}
