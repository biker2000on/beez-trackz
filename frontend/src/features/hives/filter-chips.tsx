"use client";

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface FilterChipOption {
  value: string;
  label: string;
}

/**
 * Timeline filter chips: at most `visible` chips in the row, the rest behind
 * "More". A chosen option from the overflow takes the last visible slot, so
 * the active filter is always on screen. Chips are 44px on coarse pointers.
 */
export function FilterChips({
  label,
  options,
  active,
  onSelect,
  visible = 4,
  multiple = false,
}: {
  /** Several options can be pressed at once (keeps "More" open on pick). */
  multiple?: boolean;
  /** Accessible name of the group ("Filter the timeline"). */
  label: string;
  options: readonly FilterChipOption[];
  /** Values currently pressed. */
  active: readonly string[];
  onSelect: (value: string) => void;
  visible?: number;
}) {
  const isActive = (value: string) => active.includes(value);
  const shown = options.slice(0, visible);
  const promoted = options
    .slice(visible)
    .filter((option) => isActive(option.value));
  // Make room for chosen overflow options by dropping inactive chips from the
  // end of the row (never the first, which is "All").
  for (
    let index = shown.length - 1;
    index > 0 && shown.length + promoted.length > visible;
    index -= 1
  ) {
    if (!isActive(shown[index].value)) shown.splice(index, 1);
  }
  shown.push(...promoted);
  const overflow = options.filter((option) => !shown.includes(option));
  const overflowActive = overflow.filter((option) => isActive(option.value)).length;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={label}
    >
      {shown.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={isActive(option.value)}
          onClick={() => onSelect(option.value)}
          className={cn(
            "inline-flex min-h-9 shrink-0 items-center rounded-full border px-3 text-sm font-medium transition-colors touch:min-h-11 touch:px-4",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isActive(option.value)
              ? "border-primary bg-primary/12 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9 rounded-full px-3 text-sm text-muted-foreground touch:min-h-11"
            >
              More
              {overflowActive > 0 ? ` (${overflowActive})` : ""}
              <ChevronDown className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {overflow.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={isActive(option.value)}
                onCheckedChange={() => onSelect(option.value)}
                onSelect={(event) => {
                  // Several types can be on at once; keep the menu open.
                  if (multiple) event.preventDefault();
                }}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
