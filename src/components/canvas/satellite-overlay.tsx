"use client";

import { useEffect, useState } from "react";
import { Image as KonvaImage } from "react-konva";
import { getTileUrl, getRecommendedZoom } from "@/lib/map-utils";

interface SatelliteOverlayProps {
  latitude: number;
  longitude: number;
  canvasWidth: number;
  canvasHeight: number;
  opacity: number;
}

/**
 * Satellite overlay component that renders an OpenStreetMap tile
 * behind the hive icons on the canvas
 */
export function SatelliteOverlay({
  latitude,
  longitude,
  canvasWidth,
  canvasHeight,
  opacity,
}: SatelliteOverlayProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<number>(
    getRecommendedZoom(canvasWidth, canvasHeight)
  );

  useEffect(() => {
    // Update zoom level when canvas dimensions change
    const newZoom = getRecommendedZoom(canvasWidth, canvasHeight);
    setZoom(newZoom);
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    // Load tile image from OpenStreetMap
    const tileUrl = getTileUrl(latitude, longitude, zoom);
    const img = new window.Image();

    img.crossOrigin = "anonymous"; // Enable CORS for OSM tiles
    img.onload = () => {
      setImage(img);
    };
    img.onerror = () => {
      console.error("Failed to load satellite tile:", tileUrl);
      setImage(null);
    };

    img.src = tileUrl;

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [latitude, longitude, zoom]);

  if (!image) {
    return null;
  }

  // OSM tiles are 256x256 pixels
  // Scale to fill canvas while maintaining aspect ratio
  const tileSize = 256;
  const scaleX = canvasWidth / tileSize;
  const scaleY = canvasHeight / tileSize;
  const scale = Math.max(scaleX, scaleY);

  // Center the tile on canvas
  const x = (canvasWidth - tileSize * scale) / 2;
  const y = (canvasHeight - tileSize * scale) / 2;

  return (
    <KonvaImage
      image={image}
      x={x}
      y={y}
      width={tileSize}
      height={tileSize}
      scaleX={scale}
      scaleY={scale}
      opacity={opacity}
      listening={false}
    />
  );
}
