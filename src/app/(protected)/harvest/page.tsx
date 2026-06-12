import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  getHarvests,
  getSales,
  getHoneyOverview,
  getHoneyTimeline,
  getSaleLocations,
} from "@/actions/honey";
import { getJarSizes } from "@/actions/jar-sizes";
import { getHarvestSessions } from "@/actions/harvest-sessions";
import { HarvestTable } from "@/components/honey/harvest-table";
import { SalesTable } from "@/components/honey/sales-table";
import { HoneyQuickActions } from "@/components/honey/honey-quick-actions";
import { HoneyTimeline } from "@/components/honey/honey-timeline";

export default async function HoneyPage() {
  const [overview, timeline, harvests, sales, sessions, sizes, locations] =
    await Promise.all([
      getHoneyOverview(),
      getHoneyTimeline(),
      getHarvests(),
      getSales(),
      getHarvestSessions(),
      getJarSizes(),
      getSaleLocations(),
    ]);

  const onHandBySize = new Map(overview.inventory.map((i) => [i.jarSizeId, i.onHand]));
  const sizeOptions = sizes.map((s) => ({
    id: s.id,
    label: s.label,
    honeyOz: s.honeyOz,
    defaultPrice: s.defaultPrice,
    onHand: onHandBySize.get(s.id) ?? 0,
  }));
  const jarsOnHand = overview.inventory.reduce((s, i) => s + i.onHand, 0);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold">Honey</h1>
        <HoneyQuickActions sizes={sizeOptions} locations={locations} />
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Bulk on hand"
          value={overview.bulkOnHandLbs.toFixed(1)}
          unit="lbs"
          sub={`of ${overview.totalHarvestedLbs.toFixed(1)} lbs harvested`}
        />
        <StatCard
          label="Jars on hand"
          value={String(jarsOnHand)}
          sub={`${overview.jarredLbs.toFixed(1)} lbs jarred`}
        />
        <StatCard
          label="Revenue"
          value={`$${overview.totalRevenue.toFixed(2)}`}
          sub={`${overview.jarsSold} jars sold`}
        />
        <StatCard
          label="Used + losses"
          value={(overview.bulkUsedLbs + overview.lossLbs).toFixed(1)}
          unit="lbs"
          sub={`${overview.bulkUsedLbs.toFixed(1)} used · ${overview.lossLbs.toFixed(1)} lost`}
        />
      </div>

      <Tabs defaultValue="activity">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="inventory">
            Jars
            {jarsOnHand > 0 && (
              <Badge variant="secondary" className="ml-2">
                {jarsOnHand}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="harvests">
            Harvests
            {sessions.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {sessions.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="sales">
            Sales
            {sales.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {sales.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="mt-4">
          <HoneyTimeline entries={timeline} />
        </TabsContent>

        <TabsContent value="inventory" className="mt-4">
          {overview.inventory.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No jar sizes configured yet.{" "}
              <Link href="/settings/jar-sizes" className="text-primary hover:underline">
                Set up jar sizes
              </Link>
            </p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Size</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Jarred</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Sold</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Given</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.inventory.map((row) => (
                    <TableRow key={row.jarSizeId}>
                      <TableCell className="font-medium">
                        {row.label}
                        {row.honeyOz != null && (
                          <span className="text-xs text-muted-foreground ml-1.5">
                            {row.honeyOz} oz
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {row.onHand}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell">
                        {row.jarred + row.adjusted}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell">
                        {row.sold}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden sm:table-cell">
                        {row.givenAway}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden md:table-cell">
                        {row.defaultPrice != null ? `$${row.defaultPrice.toFixed(2)}` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Counts are derived from the activity ledger. Use Adjust Jars for
            corrections;{" "}
            <Link href="/settings/jar-sizes" className="text-primary hover:underline">
              manage sizes and prices
            </Link>
            .
          </p>
        </TabsContent>

        <TabsContent value="harvests" className="mt-4 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Harvest Sessions</h2>
            <Link href="/harvest/sessions/new">
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1.5" />
                New Session
              </Button>
            </Link>
          </div>
          {sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No harvest sessions yet. Create one to track honey extraction.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {sessions.map((session) => (
                <Link key={session.id} href={`/harvest/sessions/${session.id}`}>
                  <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <p className="font-semibold">
                          {new Date(session.date).toLocaleDateString()}
                        </p>
                        <Badge variant="outline">{session.apiaryName}</Badge>
                        <Badge variant="secondary">
                          {session.entryCount} {session.entryCount === 1 ? "entry" : "entries"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                        <span>
                          Calculated:{" "}
                          <strong className="text-foreground tabular-nums">
                            {session.calculatedTotal.toFixed(1)} lbs
                          </strong>
                        </span>
                        {session.totalExtractedWeight !== null && (
                          <span>
                            Actual:{" "}
                            <strong className="text-foreground tabular-nums">
                              {session.totalExtractedWeight.toFixed(1)} lbs
                            </strong>
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Individual Harvests</h2>
            <Link href="/harvest/new">
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-1.5" />
                New Harvest
              </Button>
            </Link>
          </div>
          <HarvestTable harvests={harvests} />
        </TabsContent>

        <TabsContent value="sales" className="mt-4">
          <SalesTable sales={sales} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-xl md:text-2xl font-bold tabular-nums mt-0.5">
          {value}
          {unit && (
            <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>
          )}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
