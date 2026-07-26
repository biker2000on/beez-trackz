"use client";

import * as React from "react";
import { DollarSign, HeartPulse, Scale, TrendingUp } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatLbs, formatMoney } from "@/features/honey/format";
import {
  useEconomicsReport,
  useSurvivalReport,
  useYieldReport,
  type SurvivalGroup,
} from "./hooks";

export function OperationsDashboard() {
  const [year, setYear] = React.useState(new Date().getFullYear() - 1);
  const survival = useSurvivalReport(year);
  const yields = useYieldReport(year);
  const economics = useEconomicsReport(year);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operation reports</h1>
          <p className="text-sm text-muted-foreground">
            Survival, yield, and apiary economics from the records you already keep.
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="report-year" className="text-xs">Season year</Label>
          <Input
            id="report-year"
            type="number"
            min="2000"
            max="2200"
            className="w-28"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ReportStat
          label="Winter survival"
          value={survival.data ? `${survival.data.survivalRate.toFixed(0)}%` : undefined}
          detail={survival.data ? `${survival.data.survived}/${survival.data.enteredWinter} colonies` : undefined}
          icon={HeartPulse}
          loading={survival.isPending}
        />
        <ReportStat
          label="Honey harvested"
          value={yields.data ? formatLbs(yields.data.totalPounds) : undefined}
          detail={`${year} harvest`}
          icon={Scale}
          loading={yields.isPending}
        />
        <ReportStat
          label="Top hive"
          value={yields.data?.byHive[0]?.hiveName ?? "—"}
          detail={yields.data?.byHive[0] ? formatLbs(yields.data.byHive[0].pounds) : "No harvests"}
          icon={TrendingUp}
          loading={yields.isPending}
        />
        <ReportStat
          label="Apiary margin"
          value={economics.data ? formatMoney(economics.data.apiaries.reduce((sum, row) => sum + row.margin, 0)) : undefined}
          detail="Revenue allocated by yield"
          icon={DollarSign}
          loading={economics.isPending}
        />
      </div>

      <Tabs defaultValue="survival">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="survival">Winter survival</TabsTrigger>
          <TabsTrigger value="yield">Honey yield</TabsTrigger>
          <TabsTrigger value="economics">Apiary economics</TabsTrigger>
        </TabsList>
        <TabsContent value="survival" className="grid gap-5 pt-4">
          {survival.isPending ? <Skeleton className="h-64" /> : survival.data ? (
            <>
              <SurvivalTable title="By apiary" rows={survival.data.byApiary} />
              <SurvivalTable title="By stand position" rows={survival.data.byStand} />
              <SurvivalTable title="By queen line" rows={survival.data.byQueenLine} />
            </>
          ) : <ErrorText />}
        </TabsContent>
        <TabsContent value="yield" className="grid gap-5 pt-4">
          {yields.isPending ? <Skeleton className="h-64" /> : yields.data ? (
            <>
              <Card>
                <CardHeader><CardTitle className="text-base">Hive leaderboard</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow><TableHead>Hive</TableHead><TableHead>Apiary</TableHead><TableHead className="text-right">Honey</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {yields.data.byHive.map((row) => (
                        <TableRow key={row.hiveId}>
                          <TableCell className="font-medium">{row.hiveName}</TableCell>
                          <TableCell>{row.apiaryName}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatLbs(row.pounds)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Year over year</CardTitle></CardHeader>
                <CardContent className="flex min-h-44 items-end gap-3">
                  {yields.data.byYear.map((row) => {
                    const max = Math.max(1, ...yields.data.byYear.map((item) => item.pounds));
                    return (
                      <div key={row.year} className="flex flex-1 flex-col items-center gap-1">
                        <span className="text-xs font-medium">{row.pounds.toFixed(1)}</span>
                        <div className="w-full max-w-20 rounded-t bg-amber-500/80" style={{ height: `${Math.max(5, row.pounds / max * 110)}px` }} />
                        <span className="text-xs text-muted-foreground">{row.year}</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </>
          ) : <ErrorText />}
        </TabsContent>
        <TabsContent value="economics" className="pt-4">
          {economics.isPending ? <Skeleton className="h-64" /> : economics.data ? (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Apiary</TableHead><TableHead className="text-right">lb/hive</TableHead>
                    <TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Expenses</TableHead>
                    <TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Feed/colony</TableHead>
                    <TableHead className="text-right">Treatment/colony</TableHead>
                    <TableHead className="text-right">Winter survival</TableHead>
                    <TableHead className="text-right">Splits surviving</TableHead>
                    <TableHead className="text-right">Introduced queens active</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {economics.data.apiaries.map((row) => (
                      <TableRow key={row.apiaryId}>
                        <TableCell className="font-medium">{row.apiaryName}</TableCell>
                        <TableCell className="text-right">{row.poundsPerHive.toFixed(1)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.revenueAllocated)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.expenses)}</TableCell>
                        <TableCell className="text-right font-medium">{formatMoney(row.margin)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.feedCostPerColony)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.treatmentCostPerColony)}</TableCell>
                        <TableCell className="text-right">{row.survivedWinter}/{row.enteredWinter} ({row.winterSurvivalRate.toFixed(0)}%)</TableCell>
                        <TableCell className="text-right">{row.splitChildrenSurviving}/{row.splitsCreated}</TableCell>
                        <TableCell className="text-right">{row.introducedQueensActive}/{row.queensIntroduced}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : <ErrorText />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReportStat({
  label, value, detail, icon: Icon, loading,
}: {
  label: string; value?: string; detail?: string; icon: typeof HeartPulse; loading: boolean;
}) {
  return (
    <Card><CardContent className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Icon className="size-4" />{label}</p>
      {loading || value == null ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="mt-1 text-2xl font-bold">{value}</p>}
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </CardContent></Card>
  );
}

function SurvivalTable({ title, rows }: { title: string; rows: SurvivalGroup[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Group</TableHead><TableHead className="text-right">Entered winter</TableHead><TableHead className="text-right">Survived</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => <TableRow key={row.key}><TableCell className="font-medium">{row.label}</TableCell><TableCell className="text-right">{row.enteredWinter}</TableCell><TableCell className="text-right">{row.survived}</TableCell><TableCell className="text-right font-semibold">{row.survivalRate.toFixed(0)}%</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ErrorText() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Could not load this report.</p>;
}
