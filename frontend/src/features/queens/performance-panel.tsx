"use client";

import { Award, ChartNoAxesCombined } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useQueenPerformance } from "./api";

function scoreTone(score: number) {
  if (score >= 80) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 60) return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

export function QueenPerformancePanel() {
  const performance = useQueenPerformance();

  if (performance.isPending) return <Skeleton className="h-56 rounded-xl" />;
  if (performance.isError || !performance.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queen performance unavailable</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const ranked = [...performance.data.queens]
    .filter((queen) => queen.inspectionCount > 0)
    .sort((a, b) => b.overallScore - a.overallScore);
  const bestLine = [...performance.data.lineages].sort(
    (a, b) => b.averageScore - a.averageScore,
  )[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartNoAxesCombined className="size-5 text-primary" />
          Queen performance
        </CardTitle>
        <CardDescription>
          Overall score: brood 30%, temperament 25%, honey yield 30%, colony
          survival 15%. More inspections make comparisons more useful.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {bestLine ? (
          <div className="flex items-center gap-3 rounded-lg bg-primary/8 p-3">
            <Award className="size-5 text-primary" />
            <p className="text-sm">
              Best recorded lineage averages{" "}
              <strong>{bestLine.averageScore.toFixed(1)}</strong> across{" "}
              {bestLine.queenCount} queen
              {bestLine.queenCount === 1 ? "" : "s"}.
            </p>
          </div>
        ) : null}
        {ranked.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queen / hive</TableHead>
                <TableHead className="text-right">Overall</TableHead>
                <TableHead className="text-right">Brood</TableHead>
                <TableHead className="text-right">Temperament</TableHead>
                <TableHead className="text-right">Yield</TableHead>
                <TableHead className="text-right">Inspections</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((queen) => (
                <TableRow key={queen.id}>
                  <TableCell>
                    <p className="font-medium">
                      {queen.apiaryName && queen.hiveName
                        ? `${queen.apiaryName} · ${queen.hiveName}`
                        : `Queen ${queen.id.slice(0, 8)}`}
                    </p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {queen.status}
                    </p>
                  </TableCell>
                  <TableCell
                    className={`text-right text-base font-bold ${scoreTone(queen.overallScore)}`}
                  >
                    {queen.overallScore.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right">
                    {queen.broodScore.toFixed(0)}
                  </TableCell>
                  <TableCell className="text-right">
                    {queen.temperamentScore.toFixed(0)}
                  </TableCell>
                  <TableCell className="text-right">
                    {queen.yieldPounds.toFixed(1)} lb
                  </TableCell>
                  <TableCell className="text-right">
                    {queen.inspectionCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="grid place-items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <ChartNoAxesCombined className="size-7 text-muted-foreground" />
            <p className="text-sm font-medium">No scored queens yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Scores come from inspections linked to a queen. Record an
              inspection on a hive with a queen assigned and her ranking shows
              up here.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
