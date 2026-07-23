import { cn } from "@/lib/utils";

/** Beez Trackz mark: honeycomb hexagon with a bee-stripe core. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-8", className)}
      aria-hidden="true"
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

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="text-lg font-bold tracking-tight">
        Beez <span className="text-primary">Trackz</span>
      </span>
    </span>
  );
}
