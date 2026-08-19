"use client";

import { Arrow, Group, Line, Rect, Text } from "react-konva";

import { PX_PER_METER } from "../lib/geometry";
import {
  bearingPoint,
  shadowLengthM,
  type SolarPosition,
} from "../lib/solar";

export interface SunHiveMark {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

interface SunLayerProps {
  origin: { x: number; y: number };
  solar: SolarPosition;
  hives: SunHiveMark[];
  /** True when we fell back to the yard pin instead of occupied slots. */
  usingPin: boolean;
}

const BEARING_LEN = 800;

/**
 * Date-scrubbable sun overlay: sunrise/sunset bearings, current azimuth,
 * and simple hive-body shadows. No obstacles unless the operator draws them.
 */
export function SunLayer({ origin, solar, hives, usingPin }: SunLayerProps) {
  const sunDir = bearingPoint(origin, solar.azimuth, BEARING_LEN);
  const rise =
    solar.sunriseAzimuth != null
      ? bearingPoint(origin, solar.sunriseAzimuth, BEARING_LEN)
      : null;
  const set =
    solar.sunsetAzimuth != null
      ? bearingPoint(origin, solar.sunsetAzimuth, BEARING_LEN)
      : null;
  const night = solar.altitude <= 0;
  const shadowBearing = (solar.azimuth + 180) % 360;
  const shadowPx = Math.min(
    400,
    shadowLengthM(solar.altitude) * PX_PER_METER,
  );

  return (
    <Group listening={false}>
      {rise && (
        <Line
          points={[origin.x, origin.y, rise.x, rise.y]}
          stroke="#f59e0b"
          strokeWidth={1.5}
          dash={[8, 6]}
          opacity={0.7}
        />
      )}
      {set && (
        <Line
          points={[origin.x, origin.y, set.x, set.y]}
          stroke="#7c3aed"
          strokeWidth={1.5}
          dash={[8, 6]}
          opacity={0.7}
        />
      )}
      <Arrow
        points={[origin.x, origin.y, sunDir.x, sunDir.y]}
        stroke={night ? "#64748b" : "#fbbf24"}
        fill={night ? "#64748b" : "#fbbf24"}
        strokeWidth={2}
        pointerLength={10}
        pointerWidth={10}
        opacity={night ? 0.45 : 0.9}
      />
      <Text
        x={origin.x + 8}
        y={origin.y - 18}
        text={
          night
            ? "Sun below horizon"
            : `Sun ${Math.round(solar.azimuth)}° · alt ${solar.altitude.toFixed(1)}°`
        }
        fontSize={12}
        fill={night ? "#94a3b8" : "#92400e"}
      />
      {usingPin && (
        <Text
          x={origin.x + 8}
          y={origin.y - 2}
          text="Using yard pin — give stands GPS for per-hive sun"
          fontSize={11}
          fill="#78716c"
        />
      )}

      {!night &&
        hives.map((hive, i) => {
          const end = bearingPoint(
            { x: hive.x, y: hive.y },
            shadowBearing,
            shadowPx,
          );
          return (
            <Group key={i}>
              <Line
                points={[hive.x, hive.y, end.x, end.y]}
                stroke="rgba(15,23,42,0.35)"
                strokeWidth={Math.max(4, hive.w * 0.35)}
                lineCap="round"
              />
              <Rect
                x={hive.x - hive.w / 2}
                y={hive.y - hive.h / 2}
                width={hive.w}
                height={hive.h}
                rotation={hive.rotation}
                offsetX={0}
                offsetY={0}
                fill="rgba(15,23,42,0.12)"
              />
            </Group>
          );
        })}
    </Group>
  );
}
