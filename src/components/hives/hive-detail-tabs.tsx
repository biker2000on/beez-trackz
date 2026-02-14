"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface LocationHistoryEntry {
  apiaryName: string;
  positionLabel: string;
  dateFrom: Date;
  dateTo: Date | null;
}

interface HiveDetailTabsProps {
  locationHistory: LocationHistoryEntry[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

export function HiveDetailTabs({ locationHistory }: HiveDetailTabsProps) {
  return (
    <Tabs defaultValue="inspections">
      <TabsList>
        <TabsTrigger value="inspections">Inspections</TabsTrigger>
        <TabsTrigger value="equipment">Equipment</TabsTrigger>
        <TabsTrigger value="photos">Photos</TabsTrigger>
        <TabsTrigger value="queen">Queen</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>

      <TabsContent value="inspections">
        <p className="text-muted-foreground p-4">No inspections yet</p>
      </TabsContent>

      <TabsContent value="equipment">
        <p className="text-muted-foreground p-4">No equipment tracked</p>
      </TabsContent>

      <TabsContent value="photos">
        <p className="text-muted-foreground p-4">No photos</p>
      </TabsContent>

      <TabsContent value="queen">
        <p className="text-muted-foreground p-4">No queen assigned</p>
      </TabsContent>

      <TabsContent value="history">
        {locationHistory.length === 0 ? (
          <p className="text-muted-foreground p-4">No location history</p>
        ) : (
          <div className="space-y-3 p-4">
            {locationHistory.map((entry, index) => (
              <div
                key={index}
                className="flex items-start gap-3 text-sm"
              >
                <span className="text-lg leading-none mt-0.5">
                  {String.fromCodePoint(0x1f4cd)}
                </span>
                <div>
                  <span className="font-medium">{entry.apiaryName}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    &mdash; {entry.positionLabel}
                  </span>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    {formatDate(entry.dateFrom)} &rarr;{" "}
                    {entry.dateTo ? formatDate(entry.dateTo) : "Current"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
