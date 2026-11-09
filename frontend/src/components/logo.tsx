"use client";

import { cn } from "@/lib/utils";
import { useBrand } from "@/components/brand-provider";

/*
 * Comb Bee geometry: a bee assembled from honeycomb cells on one flat-top hex
 * grid with an even gap between neighbours — four wing cells, then a body
 * column of head, thorax, honey band, and tail. Corners are softened by a
 * same-colour round-join stroke. Frozen from `node scripts/brand-icons.mjs
 * print`; the same script renders the PNG icon set in /public/icons,
 * /public/apple-touch-icon.png and app/favicon.ico from these points.
 */
const COMB_WINGS = [
  "18.45,9.57 15.3,15.04 8.99,15.04 5.83,9.57 8.99,4.11 15.3,4.11",
  "42.17,9.57 39.01,15.04 32.7,15.04 29.55,9.57 32.7,4.11 39.01,4.11",
  "17.92,22.35 15.83,25.97 11.64,25.97 9.55,22.35 11.64,18.72 15.83,18.72",
  "38.45,22.35 36.36,25.97 32.17,25.97 30.08,22.35 32.17,18.72 36.36,18.72",
];
const COMB_BODY = [
  "27.48,5.18 25.74,8.19 22.26,8.19 20.52,5.18 22.26,2.16 25.74,2.16",
  "30.31,16.42 27.16,21.88 20.84,21.88 17.69,16.42 20.84,10.95 27.16,10.95",
  "28.33,42.09 26.17,45.84 21.83,45.84 19.67,42.09 21.83,38.34 26.17,38.34",
];
const COMB_BAND =
  "30.31,30.11 27.16,35.58 20.84,35.58 17.69,30.11 20.84,24.64 27.16,24.64";

// Pale honey for the wings: the primary lifted toward white, so it stays a
// lighter tint of the action color in both light and dark mode.
const WING_FILL = "color-mix(in oklch, var(--color-primary) 60%, white)";

/**
 * The built-in Apiary Atlas mark: the Comb Bee.
 *
 * This is the fallback whenever a deployment supplies only a name. It is drawn
 * from theme tokens (`--color-primary`, `--color-foreground`) rather than
 * fixed hex values, so it keeps its contrast in both light and dark mode.
 * Brand colors never reach it.
 */
export function FallbackMark({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-8", className)}
      // The name goes on the drawn element itself. A wrapper with
      // `display: contents` would carry the role but render no box, which is
      // both an assistive-tech and a test-visibility hazard.
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const })}
    >
      <g strokeWidth="1.53" strokeLinejoin="round">
        <g style={{ fill: WING_FILL, stroke: WING_FILL }}>
          {COMB_WINGS.map((points) => (
            <polygon key={points} points={points} />
          ))}
        </g>
        <g fill="var(--color-foreground)" stroke="var(--color-foreground)">
          {COMB_BODY.map((points) => (
            <polygon key={points} points={points} />
          ))}
        </g>
        <polygon
          points={COMB_BAND}
          fill="var(--color-primary)"
          stroke="var(--color-primary)"
        />
      </g>
    </svg>
  );
}

/**
 * The deployment's mark: a configured `BRAND_MARK_URL` image when one is set,
 * otherwise the built-in Apiary Atlas mark.
 *
 * The mark is decorative on its own — wherever it stands in for the product it
 * is paired with the brand name as text, or given one by `Logo` below — so the
 * image carries an empty `alt` and the SVG is `aria-hidden`. Callers that show
 * the mark alone pass `label` to give it an accessible name.
 *
 * The URL is only ever placed in `src`, and only after `parseBrand` has proved
 * it is a `/brand/` path or an `https://` URL. Configuration cannot inject
 * markup here.
 */
export function LogoMark({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  const brand = useBrand();

  if (brand.markUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- runtime brand URL, not a build-time asset
      <img
        src={brand.markUrl}
        alt={label ?? ""}
        className={cn("size-8 object-contain", className)}
      />
    );
  }

  return <FallbackMark className={className} label={label} />;
}

/**
 * The full lockup: mark plus wordmark.
 *
 * With `BRAND_WORDMARK_URL` set, the wordmark image replaces the type and
 * carries the display name as its alt text, so a screen reader still hears the
 * product name. Otherwise the display name is rendered as text — never as
 * markup — in the app's own type and color tokens, which is what keeps
 * contrast intact in light and dark mode regardless of the configured brand
 * colors.
 */
export function Logo({ className }: { className?: string }) {
  const brand = useBrand();

  if (brand.wordmarkUrl) {
    return (
      <span className={cn("flex items-center gap-2.5", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- runtime brand URL, not a build-time asset */}
        <img
          src={brand.wordmarkUrl}
          alt={brand.displayName}
          className="h-8 w-auto max-w-44 object-contain"
        />
      </span>
    );
  }

  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="text-lg font-bold tracking-tight">
        {brand.displayName}
      </span>
    </span>
  );
}
