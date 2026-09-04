"use client";

import { cn } from "@/lib/utils";
import { useBrand } from "@/components/brand-provider";

/**
 * The built-in Apiary Atlas mark: honeycomb hexagon with a bee-stripe core.
 *
 * This is the fallback whenever a deployment supplies only a name. It is drawn
 * from theme tokens (`--color-primary`, `--color-background`,
 * `--color-foreground`) rather than fixed hex values, so it keeps its contrast
 * in both light and dark mode. Brand colors never reach it.
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
      <path
        d="M24 3 L42 13.5 V34.5 L24 45 L6 34.5 V13.5 Z"
        fill="var(--color-primary)"
      />
      <path
        d="M24 10 L36 17 V31 L24 38 L12 31 V17 Z"
        fill="var(--color-background)"
        fillOpacity="0.92"
      />
      <ellipse cx="24" cy="24" rx="7.5" ry="9.5" fill="var(--color-primary)" />
      <rect x="16.5" y="19.5" width="15" height="2.8" rx="1.4" fill="var(--color-foreground)" opacity="0.75" />
      <rect x="16.8" y="25.2" width="14.4" height="2.8" rx="1.4" fill="var(--color-foreground)" opacity="0.75" />
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
