"use client";

import { useEffect, useRef, useState } from "react";
import { LocateFixed, Mountain } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

import { useUnits } from "@/lib/use-units";

import {
  ELEVATION_SOURCE_LABEL,
  lookupTerrainElevation,
  type ElevationSource,
} from "./elevation";
import {
  clampForageRadius,
  formatForageRadius,
  FORAGE_RADIUS_MAX_M,
  FORAGE_RADIUS_MIN_M,
  FORAGE_RADIUS_PRESETS_M,
  FORAGE_RADIUS_STEP_M,
} from "./forage-radius";
import { DEFAULT_TILE_LAYER, TILE_LAYERS, type TileLayerId } from "./tile-layers";

import "leaflet/dist/leaflet.css";

export interface LocationValue {
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  elevationSource: ElevationSource | null;
  /**
   * Forage circle drawn around the pin; also the Immich search radius.
   * Optional: a surface that only moves the pin (the canvas Set location
   * dialog) omits it, and the server then leaves the stored radius alone.
   */
  forageRadiusM?: number;
}

interface LocationPickerProps {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  disabled?: boolean;
  className?: string;
}

function parseCoord(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** ~1.1 mm at the equator. toFixed(6) was ~11 cm and clipped pin drops. */
const COORD_DECIMALS = 8;

function roundCoord(n: number): number {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(n * factor) / factor;
}

/**
 * Leaflet pin picker. Click or drag the pin; typed lat/lng write the pin.
 * Device location seeds lat/lng, then prefers an MSL terrain elevation.
 * Browser altitude is WGS84 ellipsoidal and is only a fallback.
 * No invented coordinates — empty stays empty, no map until a pin exists.
 */
function pinDistanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * k);
  return Math.hypot(dLat, dLng);
}

export function LocationPicker({
  value,
  onChange,
  disabled,
  className,
}: LocationPickerProps) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerRef = useRef<import("leaflet").CircleMarker | null>(null);
  const forageRef = useRef<import("leaflet").Circle | null>(null);
  const tileRef = useRef<import("leaflet").TileLayer | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const userClearedElevation = useRef(false);
  const lookedUpPin = useRef<{ lat: number; lng: number } | null>(null);
  const units = useUnits();
  const [layerId, setLayerId] = useState<TileLayerId>(DEFAULT_TILE_LAYER);
  const [locating, setLocating] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [latFocused, setLatFocused] = useState(false);
  const [lngFocused, setLngFocused] = useState(false);
  const [elevFocused, setElevFocused] = useState(false);
  const [latText, setLatText] = useState(
    value.latitude != null ? String(value.latitude) : "",
  );
  const [lngText, setLngText] = useState(
    value.longitude != null ? String(value.longitude) : "",
  );
  const [elevText, setElevText] = useState(
    value.elevationM != null ? String(value.elevationM) : "",
  );

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  }, [onChange, value]);

  const hasPin = value.latitude != null && value.longitude != null;

  useEffect(() => {
    const el = mapEl.current;
    if (!el || !hasPin || value.latitude == null || value.longitude == null) {
      return;
    }
    const startLat = value.latitude;
    const startLng = value.longitude;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    void import("leaflet").then((mod) => {
      const L = mod.default;
      if (cancelled || !mapEl.current) return;
      map = L.map(mapEl.current, {
        center: [startLat, startLng],
        zoom: 18,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        minZoom: 4,
        maxZoom: 20,
        zoomControl: true,
        attributionControl: true,
      });
      const def = TILE_LAYERS[layerId];
      const tile = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxNativeZoom: def.maxNativeZoom,
        maxZoom: def.maxZoom,
      }).addTo(map);
      // Forage circle first so the pin draws on top of it.
      const forage =
        valueRef.current.forageRadiusM == null
          ? null
          : L.circle([startLat, startLng], {
              radius: clampForageRadius(valueRef.current.forageRadiusM),
              color: "#d97706",
              weight: 1.5,
              dashArray: "5 5",
              fillColor: "#fbbf24",
              fillOpacity: 0.08,
              interactive: false,
            }).addTo(map);
      const marker = L.circleMarker([startLat, startLng], {
        radius: 8,
        color: "#d97706",
        weight: 2,
        fillColor: "#fbbf24",
        fillOpacity: 0.9,
        draggable: !disabled,
      } as import("leaflet").CircleMarkerOptions);
      // CircleMarker is not draggable by default; use a marker-like drag via map clicks + move.
      marker.addTo(map);
      marker.bindTooltip("Drag on the map or click to place", {
        direction: "top",
        offset: [0, -10],
      });

      const commit = (lat: number, lng: number) => {
        const cur = valueRef.current;
        onChangeRef.current({
          ...cur,
          latitude: roundCoord(lat),
          longitude: roundCoord(lng),
        });
      };

      map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
        if (disabled) return;
        marker.setLatLng(e.latlng);
        commit(e.latlng.lat, e.latlng.lng);
      });

      let dragging = false;
      marker.on("mousedown", (e: import("leaflet").LeafletMouseEvent) => {
        if (disabled) return;
        dragging = true;
        L.DomEvent.stopPropagation(e);
        map?.dragging.disable();
      });
      map.on("mousemove", (e: import("leaflet").LeafletMouseEvent) => {
        if (!dragging) return;
        marker.setLatLng(e.latlng);
      });
      const endDrag = (e?: import("leaflet").LeafletMouseEvent) => {
        if (!dragging) return;
        dragging = false;
        map?.dragging.enable();
        const ll = e?.latlng ?? marker.getLatLng();
        commit(ll.lat, ll.lng);
      };
      map.on("mouseup", endDrag);
      map.on("mouseout", endDrag);

      mapRef.current = map;
      markerRef.current = marker;
      forageRef.current = forage;
      tileRef.current = tile;
      requestAnimationFrame(() => map?.invalidateSize());
      window.setTimeout(() => map?.invalidateSize(), 250);
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      markerRef.current = null;
      forageRef.current = null;
      tileRef.current = null;
    };
    // Recreate when the map first appears. Pin moves and layer swaps
    // are applied in the effects below so we don't tear down on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pin identity, not every coord tick
  }, [hasPin, disabled]);

  useEffect(() => {
    if (value.latitude == null || value.longitude == null) return;
    const marker = markerRef.current;
    const map = mapRef.current;
    if (!marker || !map) return;
    const next = { lat: value.latitude, lng: value.longitude };
    const cur = marker.getLatLng();
    if (
      Math.abs(cur.lat - next.lat) > 1e-7 ||
      Math.abs(cur.lng - next.lng) > 1e-7
    ) {
      marker.setLatLng(next);
      forageRef.current?.setLatLng(next);
      if (!map.getBounds().contains(next)) {
        map.panTo(next);
      }
    }
  }, [value.latitude, value.longitude]);

  // The circle is the point of the map here: fit the view to it so a 5 km
  // ring is not silently cropped at zoom 18.
  useEffect(() => {
    const circle = forageRef.current;
    const map = mapRef.current;
    if (!circle || !map) return;
    if (value.forageRadiusM == null) return;
    const next = clampForageRadius(value.forageRadiusM);
    if (circle.getRadius() === next) return;
    circle.setRadius(next);
    map.fitBounds(circle.getBounds(), { padding: [16, 16], animate: false });
  }, [value.forageRadiusM]);

  useEffect(() => {
    const map = mapRef.current;
    const prev = tileRef.current;
    if (!map) return;
    void import("leaflet").then((mod) => {
      const L = mod.default;
      const def = TILE_LAYERS[layerId];
      if (prev) map.removeLayer(prev);
      const tile = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxNativeZoom: def.maxNativeZoom,
        maxZoom: def.maxZoom,
      }).addTo(map);
      tile.bringToBack();
      tileRef.current = tile;
    });
  }, [layerId]);

  // One terrain lookup per pin so clearing elevation stays empty (never invent
  // 0). A pin that moves more than ~25 m re-fetches terrain unless the
  // elevation is an operator override.
  useEffect(() => {
    if (value.latitude == null || value.longitude == null) {
      lookedUpPin.current = null;
      return;
    }
    const lat = value.latitude;
    const lng = value.longitude;
    const prev = lookedUpPin.current;
    if (prev && prev.lat === lat && prev.lng === lng) return;
    const movedFar = prev != null && pinDistanceM(prev, { lat, lng }) > 25;
    const keepExisting = (cur: Pick<LocationValue, "elevationM" | "elevationSource">) =>
      cur.elevationSource === "override" ||
      userClearedElevation.current ||
      (cur.elevationM != null && !movedFar);
    lookedUpPin.current = { lat, lng };
    if (keepExisting({ elevationM: value.elevationM, elevationSource: value.elevationSource })) {
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void lookupTerrainElevation(lat, lng, ac.signal).then((meters) => {
        if (meters == null) return;
        const cur = valueRef.current;
        if (keepExisting(cur)) return;
        onChangeRef.current({
          ...cur,
          elevationM: Math.round(meters * 10) / 10,
          elevationSource: "terrain",
        });
      });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [value.latitude, value.longitude, value.elevationM, value.elevationSource]);

  function commitCoords(latRaw: string, lngRaw: string) {
    const lat = parseCoord(latRaw);
    const lng = parseCoord(lngRaw);
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      onChange({
        ...value,
        latitude: lat != null && lat >= -90 && lat <= 90 ? lat : null,
        longitude: lng != null && lng >= -180 && lng <= 180 ? lng : null,
      });
      return;
    }
    onChange({
      ...value,
      latitude: roundCoord(lat),
      longitude: roundCoord(lng),
    });
  }

  function commitElevation(raw: string, source: ElevationSource) {
    const n = parseCoord(raw);
    if (n == null) {
      userClearedElevation.current = true;
      onChange({ ...value, elevationM: null, elevationSource: null });
      return;
    }
    userClearedElevation.current = false;
    onChange({
      ...value,
      elevationM: Math.round(n * 10) / 10,
      elevationSource: source,
    });
  }

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation is not supported by this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const altitude = position.coords.altitude;
        const hasAlt = altitude != null && Number.isFinite(altitude);
        setLookingUp(true);
        const terrain = await lookupTerrainElevation(
          position.coords.latitude,
          position.coords.longitude,
        );
        setLookingUp(false);
        setLocating(false);
        onChange({
          ...value,
          latitude: roundCoord(position.coords.latitude),
          longitude: roundCoord(position.coords.longitude),
          elevationM:
            terrain != null
              ? Math.round(terrain * 10) / 10
              : hasAlt
                ? Math.round(altitude * 10) / 10
                : value.elevationM,
          elevationSource:
            terrain != null
              ? "terrain"
              : hasAlt
                ? "geolocation"
                : value.elevationSource,
        });
        if (terrain == null) {
          toast.error(
            hasAlt
              ? "Terrain lookup failed; using GPS altitude (ellipsoidal)."
              : "Terrain lookup failed. Enter elevation yourself if you know it.",
          );
        }
      },
      (error) => {
        setLocating(false);
        if (error.code === error.PERMISSION_DENIED) {
          toast.error("Location permission denied. Enter coordinates or drop a pin.");
        } else if (error.code === error.TIMEOUT) {
          toast.error("Timed out getting your location. Try again.");
        } else {
          toast.error("Could not determine your location.");
        }
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function fillTerrain(
    lat: number,
    lng: number,
    skipIfOverride: boolean,
  ) {
    if (skipIfOverride) return;
    setLookingUp(true);
    const meters = await lookupTerrainElevation(lat, lng);
    setLookingUp(false);
    if (meters == null) {
      toast.error("Terrain lookup failed. Enter elevation yourself if you know it.");
      return;
    }
    onChange({
      ...value,
      latitude: roundCoord(lat),
      longitude: roundCoord(lng),
      elevationM: Math.round(meters * 10) / 10,
      elevationSource: "terrain",
    });
  }

  // A caller that does not pass a radius is not editing one: the canvas
  // "Set location" dialog moves the pin only. Show no ring it cannot change.
  const radius =
    value.forageRadiusM == null ? null : clampForageRadius(value.forageRadiusM);
  const layer = TILE_LAYERS[layerId];

  return (
    <div className={cn("grid gap-3", className)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="location-lat">Latitude</Label>
          <Input
            id="location-lat"
            inputMode="decimal"
            placeholder="e.g. 39.7392"
            disabled={disabled}
            value={
              latFocused
                ? latText
                : value.latitude != null
                  ? String(value.latitude)
                  : ""
            }
            onFocus={() => {
              setLatFocused(true);
              setLatText(value.latitude != null ? String(value.latitude) : "");
            }}
            onBlur={() => setLatFocused(false)}
            onChange={(e) => {
              setLatText(e.target.value);
              commitCoords(
                e.target.value,
                lngFocused
                  ? lngText
                  : value.longitude != null
                    ? String(value.longitude)
                    : "",
              );
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="location-lng">Longitude</Label>
          <Input
            id="location-lng"
            inputMode="decimal"
            placeholder="e.g. -104.9903"
            disabled={disabled}
            value={
              lngFocused
                ? lngText
                : value.longitude != null
                  ? String(value.longitude)
                  : ""
            }
            onFocus={() => {
              setLngFocused(true);
              setLngText(value.longitude != null ? String(value.longitude) : "");
            }}
            onBlur={() => setLngFocused(false)}
            onChange={(e) => {
              setLngText(e.target.value);
              commitCoords(
                latFocused
                  ? latText
                  : value.latitude != null
                    ? String(value.latitude)
                    : "",
                e.target.value,
              );
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={useCurrentLocation}
          disabled={disabled || locating}
        >
          <LocateFixed className="size-4" />
          {locating ? "Locating…" : "Use current location"}
        </Button>
        {hasPin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              userClearedElevation.current = false;
              void fillTerrain(
                value.latitude as number,
                value.longitude as number,
                false,
              );
            }}
            disabled={disabled || lookingUp}
          >
            <Mountain className="size-4" />
            {lookingUp ? "Looking up…" : "Look up terrain"}
          </Button>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="location-elev">Elevation (m above sea level)</Label>
        <Input
          id="location-elev"
          inputMode="decimal"
          placeholder="Leave blank if unknown — do not invent 0"
          disabled={disabled}
          value={
            elevFocused
              ? elevText
              : value.elevationM != null
                ? String(value.elevationM)
                : ""
          }
          onFocus={() => {
            setElevFocused(true);
            setElevText(value.elevationM != null ? String(value.elevationM) : "");
          }}
          onBlur={() => setElevFocused(false)}
          onChange={(e) => {
            setElevText(e.target.value);
            commitElevation(e.target.value, "override");
          }}
        />
        <p className="text-xs text-muted-foreground">
          Ground height, not solar altitude. Open-Meteo terrain (MSL), GPS
          altitude (ellipsoidal fallback), or type your own. Empty is fine.
          {value.elevationSource
            ? ` Current source: ${ELEVATION_SOURCE_LABEL[value.elevationSource]}.`
            : ""}
        </p>
      </div>

      {radius != null ? (
      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor="location-forage">Forage radius</Label>
          <span className="text-sm font-medium tabular-nums">
            {formatForageRadius(radius, units.units)}
          </span>
        </div>
        <Slider
          id="location-forage"
          min={FORAGE_RADIUS_MIN_M}
          max={FORAGE_RADIUS_MAX_M}
          step={FORAGE_RADIUS_STEP_M}
          value={[radius]}
          disabled={disabled}
          className="min-h-11"
          onValueChange={([next]) =>
            onChange({ ...value, forageRadiusM: clampForageRadius(next) })
          }
        />
        <div className="flex flex-wrap gap-2">
          {FORAGE_RADIUS_PRESETS_M.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="sm"
              variant={radius === preset ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onChange({ ...value, forageRadiusM: preset })}
            >
              {formatForageRadius(preset, units.units)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          The circle drawn around the pin, so the tile layer shows the tree
          line, crop, and water this yard actually works. It is also the
          radius the yard photo timeline searches around the pin.
        </p>
      </div>
      ) : null}

      {hasPin ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(TILE_LAYERS) as TileLayerId[]).map((id) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={layerId === id ? "default" : "outline"}
                onClick={() => setLayerId(id)}
              >
                {TILE_LAYERS[id].label}
              </Button>
            ))}
          </div>
          <div
            ref={mapEl}
            className="h-56 w-full overflow-hidden rounded-md border [&_.leaflet-container]:h-full [&_.leaflet-container]:w-full [&_.leaflet-container]:font-sans"
          />
          <p className="text-xs text-muted-foreground">
            Click the map or drag the pin.
            {radius != null
              ? ` The dashed ring is the ${formatForageRadius(radius, units.units)} forage circle.`
              : ""}{" "}
            {layer.seenBy} sees tile requests for this location while the map
            is open.
          </p>
        </div>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No map until a location is set. Type coordinates, use the device, or
          we will not invent a pin.
        </p>
      )}
    </div>
  );
}
