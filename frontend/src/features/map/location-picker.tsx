"use client";

import { useEffect, useRef, useState } from "react";
import { LocateFixed, Mountain } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { lookupTerrainElevation, type ElevationSource } from "./elevation";
import { DEFAULT_TILE_LAYER, TILE_LAYERS, type TileLayerId } from "./tile-layers";

import "leaflet/dist/leaflet.css";

export interface LocationValue {
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  elevationSource: ElevationSource | null;
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
 * Device location seeds lat/lng and altitude when the browser supplies it.
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
  const tileRef = useRef<import("leaflet").TileLayer | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const userClearedElevation = useRef(false);
  const lookedUpPin = useRef<{ lat: number; lng: number } | null>(null);
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
          latitude: roundCoord(lat),
          longitude: roundCoord(lng),
          elevationM: cur.elevationM,
          elevationSource: cur.elevationSource,
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
      tileRef.current = tile;
      requestAnimationFrame(() => map?.invalidateSize());
      window.setTimeout(() => map?.invalidateSize(), 250);
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      markerRef.current = null;
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
      if (!map.getBounds().contains(next)) {
        map.panTo(next);
      }
    }
  }, [value.latitude, value.longitude]);

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
        latitude: lat != null && lat >= -90 && lat <= 90 ? lat : null,
        longitude: lng != null && lng >= -180 && lng <= 180 ? lng : null,
        elevationM: value.elevationM,
        elevationSource: value.elevationSource,
      });
      return;
    }
    onChange({
      latitude: roundCoord(lat),
      longitude: roundCoord(lng),
      elevationM: value.elevationM,
      elevationSource: value.elevationSource,
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
      (position) => {
        setLocating(false);
        const altitude = position.coords.altitude;
        const hasAlt = altitude != null && Number.isFinite(altitude);
        onChange({
          latitude: roundCoord(position.coords.latitude),
          longitude: roundCoord(position.coords.longitude),
          elevationM: hasAlt ? Math.round(altitude * 10) / 10 : value.elevationM,
          elevationSource: hasAlt ? "geolocation" : value.elevationSource,
        });
        if (!hasAlt) {
          void fillTerrain(
            position.coords.latitude,
            position.coords.longitude,
            value.elevationSource === "override",
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
      latitude: roundCoord(lat),
      longitude: roundCoord(lng),
      elevationM: Math.round(meters * 10) / 10,
      elevationSource: "terrain",
    });
  }

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
          Ground height, not solar altitude. Device GPS, Open-Meteo terrain,
          or type your own. Empty is fine.
          {value.elevationSource
            ? ` Current source: ${value.elevationSource}.`
            : ""}
        </p>
      </div>

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
            Click the map or drag the pin. {layer.seenBy} sees tile requests
            for this location while the map is open.
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
