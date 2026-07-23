"use client";

import { useEffect, useMemo, useState } from "react";
import { Image as KonvaImage } from "react-konva";

import { PX_PER_METER } from "../lib/geometry";
import { buildTileMosaic, SATELLITE_ZOOM, type PlacedTile } from "../lib/tiles";

interface SatelliteLayerProps {
  latitude: number;
  longitude: number;
  /** World point where the apiary lat/lng sits (stable across edits). */
  anchor: { x: number; y: number };
  opacity: number;
}

/**
 * Georeferenced satellite imagery (Esri World Imagery) rendered in world
 * coordinates behind the stands, so it pans and zooms with the stage and
 * the canvas scale (PX_PER_METER) matches the ground scale.
 */
export function SatelliteLayer({
  latitude,
  longitude,
  anchor,
  opacity,
}: SatelliteLayerProps) {
  const tiles = useMemo(
    () =>
      buildTileMosaic({
        lat: latitude,
        lng: longitude,
        zoom: SATELLITE_ZOOM,
        pxPerMeter: PX_PER_METER,
        anchor,
        radius: 1,
      }),
    [latitude, longitude, anchor],
  );

  const [images, setImages] = useState<Map<string, HTMLImageElement>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const loaded = new Map<string, HTMLImageElement>();
    let pending = tiles.length;

    for (const tile of tiles) {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      const done = () => {
        pending--;
        if (!cancelled && pending === 0) setImages(new Map(loaded));
      };
      img.onload = () => {
        loaded.set(tile.key, img);
        done();
      };
      img.onerror = done;
      img.src = tile.url;
    }

    return () => {
      cancelled = true;
    };
  }, [tiles]);

  if (images.size === 0) return null;

  return (
    <>
      {tiles.map((tile: PlacedTile) => {
        const img = images.get(tile.key);
        if (!img) return null;
        return (
          <KonvaImage
            key={tile.key}
            image={img}
            x={tile.x}
            y={tile.y}
            width={tile.size}
            height={tile.size}
            opacity={opacity}
            listening={false}
          />
        );
      })}
    </>
  );
}
