"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HiveCard } from "./hive-card";
import { HiveTable } from "./hive-table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LayoutGrid, Table2, ListChecks, Archive, ArchiveRestore } from "lucide-react";
import { bulkUpdateHives } from "@/actions/hives";
import { useBulkSelection } from "@/components/bulk/use-bulk-selection";
import { BulkActionBar } from "@/components/bulk/bulk-action-bar";
import { useShortcut } from "@/components/keyboard/shortcut-provider";

interface HiveRow {
  id: string;
  positionLabel: string;
  status: string;
  apiaryName: string;
  installedDate: Date | null;
  isArchived: boolean;
}

interface HiveListViewProps {
  hives: HiveRow[];
  showArchived: boolean;
}

export function HiveListView({ hives, showArchived }: HiveListViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const selection = useBulkSelection();
  const [bulkStatus, setBulkStatus] = useState("");

  const [view, setView] = useState<"card" | "table">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("hiveListView") as "card" | "table") || "card";
    }
    return "card";
  });

  useShortcut("b", "Toggle bulk selection", "Hives", selection.toggleSelecting);

  const toggleView = (newView: "card" | "table") => {
    setView(newView);
    localStorage.setItem("hiveListView", newView);
  };

  const toggleShowArchived = (checked: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (checked) {
      params.set("showArchived", "true");
    } else {
      params.delete("showArchived");
    }
    router.push(`?${params.toString()}`);
  };

  const applyBulk = (patch: {
    status?: "active" | "dead" | "sold" | "combined";
    isArchived?: boolean;
  }) => {
    startTransition(async () => {
      await bulkUpdateHives({ hiveIds: [...selection.selected], ...patch });
      selection.clear();
      setBulkStatus("");
      router.refresh();
    });
  };

  const selectionProps = {
    selecting: selection.selecting,
    selected: selection.selected,
    onToggle: selection.toggle,
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1">
          <Button
            variant={view === "card" ? "default" : "outline"}
            size="icon"
            onClick={() => toggleView("card")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "table" ? "default" : "outline"}
            size="icon"
            onClick={() => toggleView("table")}
          >
            <Table2 className="h-4 w-4" />
          </Button>
          <Button
            variant={selection.selecting ? "default" : "outline"}
            size="sm"
            className="ml-2 gap-1.5"
            onClick={selection.toggleSelecting}
            title="Toggle bulk selection (b)"
          >
            <ListChecks className="h-4 w-4" />
            Select
          </Button>
          {selection.selecting && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => selection.selectAll(hives.map((h) => h.id))}
            >
              All {hives.length}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="showArchived"
            checked={showArchived}
            onCheckedChange={toggleShowArchived}
          />
          <Label
            htmlFor="showArchived"
            className="text-sm font-medium leading-none cursor-pointer"
          >
            Show Archived
          </Label>
        </div>
      </div>

      {view === "card" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {hives.map((hive) => (
            <HiveCard key={hive.id} {...hive} {...selectionProps} />
          ))}
        </div>
      ) : (
        <HiveTable hives={hives} {...selectionProps} />
      )}

      <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
        <Select
          value={bulkStatus}
          onValueChange={(v) => {
            setBulkStatus(v);
            applyBulk({ status: v as "active" | "dead" | "sold" | "combined" });
          }}
        >
          <SelectTrigger className="h-8 w-36" disabled={pending}>
            <SelectValue placeholder="Set status…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="dead">Dead</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
            <SelectItem value="combined">Combined</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          onClick={() => applyBulk({ isArchived: true })}
        >
          <Archive className="h-3.5 w-3.5" />
          Archive
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          onClick={() => applyBulk({ isArchived: false })}
        >
          <ArchiveRestore className="h-3.5 w-3.5" />
          Unarchive
        </Button>
      </BulkActionBar>
    </div>
  );
}
