"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowUpDown } from "lucide-react";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-200",
  dead: "bg-red-500/10 text-red-700 border-red-200",
  sold: "bg-blue-500/10 text-blue-700 border-blue-200",
  combined: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
};

interface HiveRow {
  id: string;
  positionLabel: string;
  status: string;
  apiaryName: string;
  installedDate: Date | null;
}

interface HiveTableProps {
  hives: HiveRow[];
}

type SortKey = "positionLabel" | "status" | "apiaryName" | "installedDate";

export function HiveTable({ hives }: HiveTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("positionLabel");
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = [...hives].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortKey === "installedDate") {
      const da = a.installedDate ? new Date(a.installedDate).getTime() : 0;
      const db = b.installedDate ? new Date(b.installedDate).getTime() : 0;
      return (da - db) * dir;
    }
    const va = (a[sortKey] || "").toLowerCase();
    const vb = (b[sortKey] || "").toLowerCase();
    return va.localeCompare(vb) * dir;
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="cursor-pointer" onClick={() => toggleSort("positionLabel")}>
            Location <ArrowUpDown className="inline h-3 w-3 ml-1" />
          </TableHead>
          <TableHead className="cursor-pointer" onClick={() => toggleSort("status")}>
            Status <ArrowUpDown className="inline h-3 w-3 ml-1" />
          </TableHead>
          <TableHead className="cursor-pointer" onClick={() => toggleSort("apiaryName")}>
            Apiary <ArrowUpDown className="inline h-3 w-3 ml-1" />
          </TableHead>
          <TableHead className="cursor-pointer" onClick={() => toggleSort("installedDate")}>
            Installed <ArrowUpDown className="inline h-3 w-3 ml-1" />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((hive) => (
          <TableRow key={hive.id} className="cursor-pointer hover:bg-accent/50">
            <TableCell>
              <Link href={`/hives/${hive.id}`} className="font-medium hover:underline">
                {hive.positionLabel}
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className={statusColors[hive.status] || ""}>
                {hive.status}
              </Badge>
            </TableCell>
            <TableCell>{hive.apiaryName}</TableCell>
            <TableCell>
              {hive.installedDate
                ? new Date(hive.installedDate).toLocaleDateString()
                : "-"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
