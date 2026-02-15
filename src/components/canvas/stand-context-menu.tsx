"use client";

import { useEffect, useRef } from "react";

interface StandContextMenuProps {
  position: { x: number; y: number };
  standLabel: string;
  slotLabel?: string;
  slotOccupied?: boolean;
  isMultiOccupant?: boolean;
  onClose: () => void;
  onRenameStand: () => void;
  onResizeStand: () => void;
  onRotateStand: () => void;
  onDeleteStand: () => void;
  onAddNewHive?: () => void;
  onAssignExistingHive?: () => void;
  onSplitHive?: () => void;
  onAddNuc?: () => void;
  onRemoveHiveFromSlot?: () => void;
}

export function StandContextMenu({ position, standLabel, slotLabel, slotOccupied, isMultiOccupant, onClose, ...actions }: StandContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[180px]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
        Stand {standLabel}{slotLabel ? ` / ${slotLabel}` : ""}
      </div>
      <div className="h-px bg-border my-1" />

      {/* Stand-level actions */}
      <MenuItem label="Rename Stand" onClick={actions.onRenameStand} />
      <MenuItem label="Resize Stand" onClick={actions.onResizeStand} />
      <MenuItem label="Rotate Stand" onClick={actions.onRotateStand} />

      {slotLabel && !slotOccupied && (
        <>
          <div className="h-px bg-border my-1" />
          <MenuItem label="Add New Hive" onClick={actions.onAddNewHive} />
          <MenuItem label="Assign Existing Hive" onClick={actions.onAssignExistingHive} />
        </>
      )}

      {slotLabel && slotOccupied && (
        <>
          <div className="h-px bg-border my-1" />
          <MenuItem label="Split Hive" onClick={actions.onSplitHive} />
          <MenuItem label="Add Nuc" onClick={actions.onAddNuc} />
          <MenuItem label="Remove from Slot" onClick={actions.onRemoveHiveFromSlot} />
        </>
      )}

      <div className="h-px bg-border my-1" />
      <MenuItem label="Delete Stand" onClick={actions.onDeleteStand} className="text-destructive" />
    </div>
  );
}

function MenuItem({ label, onClick, className }: { label: string; onClick?: () => void; className?: string }) {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${className || ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
