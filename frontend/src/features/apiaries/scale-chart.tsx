"use client";

import * as React from "react";

import { useUnits } from "@/lib/use-units";

import type { ScaleSeriesResponse } from "./scale-hooks";

/**
 * Daily yard weight with the bloom windows and inspection days that explain
 * it. Hand-drawn SVG, matching the rest of the app's charts — no chart
 * dependency, and it reads in sunlight because the shapes carry the meaning.
 *
 * A weight curve on its own says "it went up in June". Overlaid on bloom it
 * says "sourwood opened and the yard put on 40 lb"; overlaid on inspections
 * it says "that 30 lb cliff was me pulling supers, not robbing."
 */

const CHART_W = 720;
const CHART_H = 220;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;

const SERIES_CLASS = [
  "text-primary",
  "text-sky-600 dark:text-sky-400",
  "text-emerald-600 dark:text-emerald-400",
];

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
}

function shortDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ScaleChart({ data }: { data: ScaleSeriesResponse }) {
  const units = useUnits();

  const model = React.useMemo(() => {
    const series = data.scales.filter((scale) => scale.points.length > 0);
    if (series.length === 0) return null;

    const from = dayNumber(data.from);
    const to = dayNumber(data.to);
    const span = Math.max(1, to - from);

    let low = Infinity;
    let high = -Infinity;
    for (const scale of series) {
      for (const point of scale.points) {
        low = Math.min(low, point.minLb ?? point.weightLb);
        high = Math.max(high, point.maxLb ?? point.weightLb);
      }
    }
    // A flat week must not become a jittery full-height line.
    const pad = Math.max(2, (high - low) * 0.1);
    low -= pad;
    high += pad;
    const range = Math.max(1, high - low);

    const x = (date: string) =>
      PAD_L +
      ((Math.min(to, Math.max(from, dayNumber(date))) - from) / span) *
        (CHART_W - PAD_L - PAD_R);
    const y = (weight: number) =>
      PAD_T + (1 - (weight - low) / range) * (CHART_H - PAD_T - PAD_B);

    return {
      series,
      low,
      high,
      x,
      y,
      // A bloom still open at the end of the range clamps to the range end
      // rather than vanishing.
      blooms: data.blooms.map((bloom) => ({
        ...bloom,
        x1: x(bloom.firstSeen),
        x2: x(bloom.lastSeen ?? data.to),
      })),
      inspections: data.inspections.map((inspection) => ({
        ...inspection,
        x: x(inspection.date),
      })),
    };
  }, [data]);

  if (!model) {
    return (
      <p className="text-sm text-muted-foreground">
        No readings in this window yet. Upload a CSV export and the curve
        appears here.
      </p>
    );
  }

  const { series, low, high, x, y, blooms, inspections } = model;
  const axisUnit = units.units === "metric" ? "kg" : "lb";
  const axisValue = (pounds: number) =>
    Math.round(units.units === "metric" ? pounds * 0.45359237 : pounds);

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="h-56 w-full min-w-[560px]"
          role="img"
          aria-label={`Daily hive weight from ${shortDate(data.from)} to ${shortDate(data.to)}`}
        >
          {/* Bloom windows sit behind everything: they are the context. */}
          {blooms.map((bloom, index) => (
            <rect
              key={`${bloom.species}-${bloom.firstSeen}-${index}`}
              x={Math.min(bloom.x1, bloom.x2)}
              y={PAD_T}
              width={Math.max(1.5, Math.abs(bloom.x2 - bloom.x1))}
              height={CHART_H - PAD_T - PAD_B}
              className="fill-amber-300/25 dark:fill-amber-500/15"
            >
              <title>
                {bloom.species} · {shortDate(bloom.firstSeen)}
                {bloom.lastSeen ? `–${shortDate(bloom.lastSeen)}` : " (open)"}
              </title>
            </rect>
          ))}

          {/* Gridlines: the two weights that bound the window, and the middle. */}
          {[high, (high + low) / 2, low].map((value) => (
            <g key={value} className="text-muted-foreground">
              <line
                x1={PAD_L}
                x2={CHART_W - PAD_R}
                y1={y(value)}
                y2={y(value)}
                stroke="currentColor"
                strokeWidth={0.5}
                strokeDasharray="3 4"
                opacity={0.5}
              />
              <text
                x={PAD_L - 6}
                y={y(value) + 3}
                textAnchor="end"
                fill="currentColor"
                fontSize={9}
              >
                {axisValue(value)}
              </text>
            </g>
          ))}

          {/* Inspection days as ticks under the baseline. */}
          {inspections.map((inspection, index) => (
            <line
              key={`${inspection.date}-${inspection.hiveLabel}-${index}`}
              x1={inspection.x}
              x2={inspection.x}
              y1={CHART_H - PAD_B}
              y2={CHART_H - PAD_B + 6}
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-muted-foreground"
            >
              <title>
                Inspected {inspection.hiveLabel} on {shortDate(inspection.date)}
              </title>
            </line>
          ))}

          {series.map((scale, index) => (
            <g
              key={scale.scaleId}
              className={SERIES_CLASS[index % SERIES_CLASS.length]}
            >
              <polyline
                points={scale.points
                  .map((point) => `${x(point.date)},${y(point.weightLb)}`)
                  .join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* The last day gets a dot so "where is it now" is one glance. */}
              <circle
                cx={x(scale.points[scale.points.length - 1].date)}
                cy={y(scale.points[scale.points.length - 1].weightLb)}
                r={3}
                fill="currentColor"
              />
            </g>
          ))}

          <line
            x1={PAD_L}
            x2={CHART_W - PAD_R}
            y1={CHART_H - PAD_B}
            y2={CHART_H - PAD_B}
            stroke="currentColor"
            strokeWidth={1}
            className="text-border"
          />
          <text
            x={PAD_L}
            y={CHART_H - 8}
            fill="currentColor"
            fontSize={10}
            className="text-muted-foreground"
          >
            {shortDate(data.from)}
          </text>
          <text
            x={CHART_W - PAD_R}
            y={CHART_H - 8}
            textAnchor="end"
            fill="currentColor"
            fontSize={10}
            className="text-muted-foreground"
          >
            {shortDate(data.to)}
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((scale, index) => (
          <span
            key={scale.scaleId}
            className={`inline-flex items-center gap-1.5 ${SERIES_CLASS[index % SERIES_CLASS.length]}`}
          >
            <span className="h-0.5 w-4 rounded-full bg-current" />
            {scale.name}
            {scale.hiveLabel ? ` (${scale.hiveLabel})` : ""}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-4 rounded-sm bg-amber-300/50 dark:bg-amber-500/30" />
          Bloom window
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-current" />
          Inspection
        </span>
        <span>Weight axis in {axisUnit}</span>
      </div>
    </div>
  );
}
