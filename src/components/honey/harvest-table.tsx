import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface HarvestEntry {
  id: string;
  hiveId: string;
  date: Date;
  superWeightBefore: number;
  superWeightAfter: number;
  calculatedHoneyWeight: number;
  notes: string | null;
  hiveName: string;
  apiaryName: string;
}

interface HarvestTableProps {
  harvests: HarvestEntry[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function HarvestTable({ harvests }: HarvestTableProps) {
  if (harvests.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-8">
        No harvests recorded yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Hive</TableHead>
          <TableHead className="text-right">Before (lbs)</TableHead>
          <TableHead className="text-right">After (lbs)</TableHead>
          <TableHead className="text-right">Honey Yield (lbs)</TableHead>
          <TableHead>Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {harvests.map((h) => (
          <TableRow key={h.id}>
            <TableCell>{formatDate(h.date)}</TableCell>
            <TableCell>
              {h.hiveName} <span className="text-muted-foreground text-xs">({h.apiaryName})</span>
            </TableCell>
            <TableCell className="text-right">{h.superWeightBefore.toFixed(1)}</TableCell>
            <TableCell className="text-right">{h.superWeightAfter.toFixed(1)}</TableCell>
            <TableCell className="text-right font-medium">{h.calculatedHoneyWeight.toFixed(1)}</TableCell>
            <TableCell className="max-w-[200px] truncate text-muted-foreground text-xs">
              {h.notes || "--"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
