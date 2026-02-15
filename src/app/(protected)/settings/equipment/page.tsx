import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus } from "lucide-react";
import {
  getAllEquipment,
  getFrameShortage,
} from "@/actions/equipment";
import { FrameShortageCard } from "@/components/equipment/frame-shortage-card";

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

export default async function EquipmentInventoryPage() {
  const [allEquipment, shortage] = await Promise.all([
    getAllEquipment(),
    getFrameShortage(),
  ]);

  const onHives = allEquipment.filter((e) => e.hiveId != null);
  const inStorage = allEquipment.filter((e) => e.hiveId == null);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Equipment Inventory</h1>
        <Link href="/settings/equipment/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Add Equipment
          </Button>
        </Link>
      </div>

      {/* Frame shortage summary */}
      <FrameShortageCard data={shortage} />

      {/* On Hives */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            On Hives ({onHives.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {onHives.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No equipment assigned to hives.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Frames</TableHead>
                  <TableHead>Frame Type</TableHead>
                  <TableHead>Hive</TableHead>
                  <TableHead>Apiary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {onHives.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">
                      {EQUIPMENT_LABELS[e.type] || e.type}
                    </TableCell>
                    <TableCell>
                      {e.frameCapacity != null
                        ? `${e.framesInstalled ?? 0}/${e.frameCapacity}`
                        : "\u2014"}
                    </TableCell>
                    <TableCell>
                      {e.frameType ? (
                        <Badge variant="outline" className="text-xs">
                          {FRAME_TYPE_LABELS[e.frameType] || e.frameType}
                        </Badge>
                      ) : (
                        "\u2014"
                      )}
                    </TableCell>
                    <TableCell>
                      {e.hiveId ? (
                        <Link
                          href={`/hives/${e.hiveId}`}
                          className="text-primary hover:underline"
                        >
                          {e.hiveName || "Unknown"}
                        </Link>
                      ) : (
                        "\u2014"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.apiaryName || "\u2014"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* In Storage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            In Storage ({inStorage.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {inStorage.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No equipment in storage.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Frames</TableHead>
                  <TableHead>Frame Type</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inStorage.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">
                      {EQUIPMENT_LABELS[e.type] || e.type}
                    </TableCell>
                    <TableCell>
                      {e.frameCapacity != null
                        ? `${e.framesInstalled ?? 0}/${e.frameCapacity}`
                        : "\u2014"}
                    </TableCell>
                    <TableCell>
                      {e.frameType ? (
                        <Badge variant="outline" className="text-xs">
                          {FRAME_TYPE_LABELS[e.frameType] || e.frameType}
                        </Badge>
                      ) : (
                        "\u2014"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.storageLocation || "Unspecified"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
