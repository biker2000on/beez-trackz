"use client";

import { useState } from "react";
import { HiveCard } from "./hive-card";
import { HiveTable } from "./hive-table";
import { Button } from "@/components/ui/button";
import { LayoutGrid, Table2 } from "lucide-react";

interface HiveListViewProps {
  hives: {
    id: string;
    positionLabel: string;
    status: string;
    apiaryName: string;
    installedDate: Date | null;
  }[];
}

export function HiveListView({ hives }: HiveListViewProps) {
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

  return (
    <div>
      <div className="flex gap-1 mb-4">
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

      {view === "card" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {hives.map((hive) => (
            <HiveCard key={hive.id} {...hive} />
          ))}
        </div>
      ) : (
        <HiveTable hives={hives} />
      )}
    </div>
  );
}
