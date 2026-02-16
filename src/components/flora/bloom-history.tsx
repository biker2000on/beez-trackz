"use client";

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DeleteButton } from "@/components/shared/delete-button";
import { deleteBloomObservation } from "@/actions/bloom-observations";

interface BloomRecord {
  id: string;
  apiaryId: string;
  species: string;
  dateFirstSeen: string;
  dateLastSeen: string | null;
  year: number;
  abundance: number | null;
  notes: string | null;
}

interface BloomHistoryProps {
  history: BloomRecord[];
}

export function BloomHistory({ history }: BloomHistoryProps) {
  const years = [...new Set(history.map((h) => h.year))].sort((a, b) => b - a);
  const [selectedYear, setSelectedYear] = useState<string>(
    years[0]?.toString() || ""
  );

  const filtered = selectedYear
    ? history.filter((h) => h.year === parseInt(selectedYear))
    : history;

  if (history.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-4">
        No bloom history yet.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Select value={selectedYear} onValueChange={setSelectedYear}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="All years" />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={y.toString()}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filtered.length} record{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="border rounded-md">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-2 font-medium">Species</th>
              <th className="text-left p-2 font-medium">First Seen</th>
              <th className="text-left p-2 font-medium">Last Seen</th>
              <th className="text-left p-2 font-medium">Abundance</th>
              <th className="text-left p-2 font-medium">Notes</th>
              <th className="text-right p-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((bloom) => (
              <tr key={bloom.id} className="border-b last:border-0">
                <td className="p-2 font-medium">{bloom.species}</td>
                <td className="p-2">{new Date(bloom.dateFirstSeen).toLocaleDateString()}</td>
                <td className="p-2">
                  {bloom.dateLastSeen
                    ? new Date(bloom.dateLastSeen).toLocaleDateString()
                    : <Badge variant="secondary">Active</Badge>
                  }
                </td>
                <td className="p-2">{bloom.abundance || "—"}</td>
                <td className="p-2 text-muted-foreground">{bloom.notes || "—"}</td>
                <td className="p-2 text-right">
                  <DeleteButton
                    onDelete={async () => {
                      await deleteBloomObservation(bloom.id, bloom.apiaryId);
                    }}
                    entityName="Bloom Observation"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
