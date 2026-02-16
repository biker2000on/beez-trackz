"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HiveCard } from "./hive-card";
import { HiveTable } from "./hive-table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { LayoutGrid, Table2 } from "lucide-react";

interface HiveListViewProps {
  hives: {
    id: string;
    positionLabel: string;
    status: string;
    apiaryName: string;
    installedDate: Date | null;
    isArchived: boolean;
  }[];
  showArchived: boolean;
}

export function HiveListView({ hives, showArchived }: HiveListViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [view, setView] = useState<"card" | "table">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("hiveListView") as "card" | "table") || "card";
    }
    return "card";
  });

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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
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
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="showArchived"
            checked={showArchived}
            onCheckedChange={toggleShowArchived}
          />
          <Label
            htmlFor="showArchived"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            Show Archived
          </Label>
        </div>
      </div>

      {view === "card" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {hives.map((hive) => (
            <HiveCard key={hive.id} {...hive} isArchived={hive.isArchived} />
          ))}
        </div>
      ) : (
        <HiveTable hives={hives} />
      )}
    </div>
  );
}
