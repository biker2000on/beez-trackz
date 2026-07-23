"use client";

import { useEffect, useRef } from "react";

/**
 * Lightweight cursor-anchored context menu. Konva shapes are not DOM nodes,
 * so Radix anchor-based menus don't fit — this renders an absolutely
 * positioned popover inside the canvas container, closing on outside
 * click or Escape.
 */

interface MenuSurfaceProps {
  position: { x: number; y: number };
  onClose: () => void;
  children: React.ReactNode;
}

export function MenuSurface({ position, onClose, children }: MenuSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Keep the menu inside the container when opened near the right/bottom edge.
  useEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const overflowX = el.offsetLeft + el.offsetWidth - parent.clientWidth;
    const overflowY = el.offsetTop + el.offsetHeight - parent.clientHeight;
    if (overflowX > 0) el.style.left = `${Math.max(0, position.x - overflowX)}px`;
    if (overflowY > 0) el.style.top = `${Math.max(0, position.y - overflowY)}px`;
  }, [position]);

  return (
    <div
      ref={ref}
      className="absolute z-50 min-w-[180px] rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
      style={{ left: position.x, top: position.y }}
    >
      {children}
    </div>
  );
}

export function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

export function MenuItem({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      className={`w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-secondary ${
        destructive ? "text-destructive" : ""
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
