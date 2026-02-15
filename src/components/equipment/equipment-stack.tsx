"use client";

import { Badge } from "@/components/ui/badge";

interface EquipmentItem {
  id: string;
  type: string;
  frameCapacity: number | null;
  framesInstalled: number | null;
  frameType: string | null;
}

interface EquipmentStackProps {
  equipment: EquipmentItem[];
}

const EQUIPMENT_LABELS: Record<string, string> = {
  deep: "Deep Body",
  medium: "Medium Super",
  shallow: "Shallow Super",
  queen_excluder: "Queen Excluder",
  double_screen: "Double Screen",
  inner_cover: "Inner Cover",
  outer_cover: "Outer Cover",
  bottom_board: "Bottom Board",
  entrance_reducer: "Entrance Reducer",
  feeder: "Feeder",
  other: "Other",
};

const FRAME_TYPE_LABELS: Record<string, string> = {
  wax_foundation: "Wax",
  plastic: "Plastic",
  foundationless: "Foundationless",
  drawn_comb: "Drawn Comb",
};

// Box types get taller visual treatment
const BOX_TYPES = new Set(["deep", "medium", "shallow"]);

// Ordering priority for a natural hive stack (top to bottom)
const STACK_ORDER: Record<string, number> = {
  outer_cover: 0,
  inner_cover: 1,
  feeder: 2,
  shallow: 3,
  medium: 4,
  queen_excluder: 5,
  double_screen: 6,
  deep: 7,
  entrance_reducer: 8,
  bottom_board: 9,
  other: 10,
};

function getStackOrder(type: string): number {
  return STACK_ORDER[type] ?? 10;
}

function sortForStack(items: EquipmentItem[]): EquipmentItem[] {
  return [...items].sort((a, b) => getStackOrder(a.type) - getStackOrder(b.type));
}

export function EquipmentStack({ equipment }: EquipmentStackProps) {
  if (equipment.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No equipment on this hive</p>
    );
  }

  const sorted = sortForStack(equipment);

  return (
    <div className="w-full max-w-sm mx-auto">
      {sorted.map((item, index) => {
        const isBox = BOX_TYPES.has(item.type);
        const isFirst = index === 0;
        const isLast = index === sorted.length - 1;
        const label = EQUIPMENT_LABELS[item.type] || item.type;

        return (
          <div
            key={item.id}
            className={`
              relative border-x border-t
              ${isLast ? "border-b" : ""}
              ${isFirst ? "rounded-t-lg" : ""}
              ${isLast ? "rounded-b-lg" : ""}
              ${isBox ? "min-h-[56px]" : "min-h-[32px]"}
              ${getItemStyles(item.type)}
              flex items-center justify-between px-3
              transition-colors hover:brightness-95
            `}
          >
            <span className={`font-medium ${isBox ? "text-sm" : "text-xs"}`}>
              {label}
            </span>
            <div className="flex items-center gap-2">
              {isBox && item.frameCapacity != null && (
                <span className="text-xs text-muted-foreground">
                  {item.framesInstalled ?? 0}/{item.frameCapacity} frames
                </span>
              )}
              {isBox && item.frameType && (
                <Badge variant="outline" className="text-[10px] h-5 px-1.5">
                  {FRAME_TYPE_LABELS[item.frameType] || item.frameType}
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getItemStyles(type: string): string {
  switch (type) {
    case "deep":
      return "bg-amber-100 border-amber-300 dark:bg-amber-950/40 dark:border-amber-800";
    case "medium":
      return "bg-yellow-50 border-yellow-300 dark:bg-yellow-950/30 dark:border-yellow-800";
    case "shallow":
      return "bg-yellow-50/60 border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-900";
    case "queen_excluder":
      return "bg-zinc-100 border-zinc-400 dark:bg-zinc-800 dark:border-zinc-600 border-dashed";
    case "double_screen":
      return "bg-zinc-100 border-zinc-400 dark:bg-zinc-800 dark:border-zinc-600 border-dashed";
    case "inner_cover":
      return "bg-stone-200 border-stone-400 dark:bg-stone-800 dark:border-stone-600";
    case "outer_cover":
      return "bg-stone-300 border-stone-500 dark:bg-stone-700 dark:border-stone-500";
    case "bottom_board":
      return "bg-stone-300 border-stone-500 dark:bg-stone-700 dark:border-stone-500";
    case "entrance_reducer":
      return "bg-orange-100 border-orange-300 dark:bg-orange-950/30 dark:border-orange-800";
    case "feeder":
      return "bg-sky-50 border-sky-300 dark:bg-sky-950/30 dark:border-sky-800";
    default:
      return "bg-gray-50 border-gray-300 dark:bg-gray-800 dark:border-gray-600";
  }
}
