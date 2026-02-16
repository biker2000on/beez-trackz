"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface HiveContextMenuProps {
  position: { x: number; y: number };
  hiveId: string;
  hiveName: string;
  onClose: () => void;
  onSetFacing: () => void;
  onMoveToSlot: () => void;
  onRemoveFromSlot: () => void;
  onEditHive?: () => void;
  onFlipDirection: () => void;
  onSplitHive?: () => void;
}

export function HiveContextMenu({ position, hiveId, hiveName, onClose, onSetFacing, onMoveToSlot, onRemoveFromSlot, onEditHive, onFlipDirection, onSplitHive }: HiveContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const navigate = (path: string) => {
    onClose();
    router.push(path);
  };

  return (
    <div
      ref={ref}
      className="absolute z-50 bg-popover border border-border rounded-md shadow-md py-1 min-w-[200px]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
        {hiveName}
      </div>
      <div className="h-px bg-border my-1" />

      {/* Quick actions - navigation */}
      <MenuItem label="New Inspection" onClick={() => navigate(`/hives/${hiveId}/inspections/new`)} />
      <MenuItem label="Quick Inspection" onClick={() => navigate(`/hives/${hiveId}/inspections/quick`)} />
      <MenuItem label="Record Inspection" onClick={() => navigate(`/hives/${hiveId}/transcribe`)} />
      <MenuItem label="Feed" onClick={() => navigate(`/hives/${hiveId}/feedings/new`)} />
      <MenuItem label="Add Equipment" onClick={() => navigate(`/hives/${hiveId}/equipment/new`)} />
      <MenuItem label="View Hive" onClick={() => navigate(`/hives/${hiveId}`)} />

      <div className="h-px bg-border my-1" />

      {/* Canvas actions */}
      {onEditHive && (
        <MenuItem label="Edit Hive" onClick={onEditHive} />
      )}
      <MenuItem label="Flip Direction" onClick={onFlipDirection} />
      {onSplitHive && (
        <MenuItem label="Split Hive" onClick={onSplitHive} />
      )}
      <MenuItem label="Set Facing Direction" onClick={onSetFacing} />
      <MenuItem label="Move to Slot..." onClick={onMoveToSlot} />
      <MenuItem label="Remove from Stand" onClick={onRemoveFromSlot} />
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
