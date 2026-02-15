"use client";

import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import {
  QUEEN_COLOR_HEX,
  getQueenColorForDate,
} from "@/lib/queen-colors";
import { InspectionCard } from "@/components/inspections/inspection-card";
import { EquipmentStack } from "@/components/equipment/equipment-stack";

interface LocationHistoryEntry {
  apiaryName: string;
  positionLabel: string;
  dateFrom: Date;
  dateTo: Date | null;
}

interface QueenEntry {
  id: string;
  origin: string;
  status: string;
  introducedDate: Date | null;
  notes: string | null;
}

interface InspectionEntry {
  id: string;
  hiveId: string;
  date: Date;
  inspectorName: string | null;
  queenSeen: boolean | null;
  storesHoney: number | null;
  storesPollen: number | null;
  temperament: number | null;
  pests: unknown;
  notes: string | null;
}

interface EquipmentEntry {
  id: string;
  type: string;
  frameCapacity: number | null;
  framesInstalled: number | null;
  frameType: string | null;
}

interface HiveDetailTabsProps {
  hiveId: string;
  locationHistory: LocationHistoryEntry[];
  queens: QueenEntry[];
  inspections: InspectionEntry[];
  equipment: EquipmentEntry[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function formatFullDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700",
  superseded: "bg-gray-500/10 text-gray-700",
  dead: "bg-red-500/10 text-red-700",
  missing: "bg-yellow-500/10 text-yellow-700",
};

export function HiveDetailTabs({
  hiveId,
  locationHistory,
  queens,
  inspections,
  equipment,
}: HiveDetailTabsProps) {
  const activeQueen = queens.find((q) => q.status === "active");
  const pastQueens = queens.filter((q) => q.status !== "active");

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
        <div className="p-4 space-y-3">
          {inspections.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-muted-foreground mb-3">
                No inspections yet. Record your first inspection.
              </p>
              <Link href={`/hives/${hiveId}/inspections/new`}>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  New Inspection
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {inspections.length} inspection{inspections.length !== 1 ? "s" : ""}
                </h3>
                <Link href={`/hives/${hiveId}/inspections/new`}>
                  <Button variant="outline" size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    New Inspection
                  </Button>
                </Link>
              </div>
              <div className="space-y-2">
                {inspections.map((inspection) => (
                  <InspectionCard
                    key={inspection.id}
                    inspection={inspection}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value="equipment">
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Hive Stack
            </h3>
            <Link href={`/settings/equipment/new?hiveId=${hiveId}`}>
              <Button variant="outline" size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Equipment
              </Button>
            </Link>
          </div>
          <EquipmentStack equipment={equipment} />
        </div>
      </TabsContent>

      <TabsContent value="photos">
        <p className="text-muted-foreground p-4">No photos</p>
      </TabsContent>

      <TabsContent value="queen">
        <div className="p-4 space-y-6">
          {/* Active queen */}
          {activeQueen ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Current Queen
              </h3>
              <QueenCard queen={activeQueen} />
            </div>
          ) : (
            <p className="text-muted-foreground">No active queen assigned</p>
          )}

          {/* Past queens */}
          {pastQueens.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Queen History
              </h3>
              <div className="space-y-2">
                {pastQueens.map((queen) => (
                  <QueenCard key={queen.id} queen={queen} />
                ))}
              </div>
            </div>
          )}

          {/* Add queen button */}
          <Link href={`/hives/${hiveId}/queens/new`}>
            <Button variant="outline" size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Queen
            </Button>
          </Link>
        </div>
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

function QueenCard({ queen }: { queen: QueenEntry }) {
  const color = getQueenColorForDate(queen.introducedDate);
  const colorHex = color ? QUEEN_COLOR_HEX[color] : "#94A3B8";

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div
        className="w-4 h-4 rounded-full border flex-shrink-0 mt-0.5"
        style={{ backgroundColor: colorHex }}
        title={
          color
            ? `${color} (${queen.introducedDate ? new Date(queen.introducedDate).getFullYear() : "?"})`
            : "Unknown year"
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize">{queen.origin.replace("_", " ")}</span>
          <Badge
            variant="outline"
            className={`text-xs ${statusColors[queen.status] || ""}`}
          >
            {queen.status}
          </Badge>
        </div>
        {queen.introducedDate && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Introduced {formatFullDate(queen.introducedDate)}
          </p>
        )}
        {queen.notes && (
          <p className="text-xs text-muted-foreground mt-1">{queen.notes}</p>
        )}
      </div>
    </div>
  );
}
