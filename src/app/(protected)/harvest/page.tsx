import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import {
  getHarvests,
  getHoneyInventory,
  getSales,
  getHoneyDashboard,
} from "@/actions/honey";
import { getHarvestSessions } from "@/actions/harvest-sessions";
import { HarvestTable } from "@/components/honey/harvest-table";
import { InventoryCard } from "@/components/honey/inventory-card";
import { SalesTable } from "@/components/honey/sales-table";

export default async function HarvestPage() {
  const [harvests, inventory, sales, dashboard, sessions] = await Promise.all([
    getHarvests(),
    getHoneyInventory(),
    getSales(),
    getHoneyDashboard(),
    getHarvestSessions(),
  ]);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Honey</h1>

      {/* Summary cards row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">
              Total Harvested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {dashboard.totalHarvested.toFixed(1)}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                lbs
              </span>
            </p>
          </CardContent>
        </Card>

        <InventoryCard inventory={inventory} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              ${dashboard.totalRevenue.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed content */}
      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">
            Sessions
            {sessions.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {sessions.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="harvests">
            Harvests
            {harvests.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {harvests.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="inventory">
            Inventory
            {inventory.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {inventory.reduce((s, i) => s + i.totalQuantity, 0)}
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

        {/* Sessions Tab */}
        <TabsContent value="sessions">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Harvest Sessions</h2>
            <Link href="/harvest/sessions/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Harvest Session
              </Button>
            </Link>
          </div>
          {sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No harvest sessions yet. Create one to track honey extraction.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {sessions.map((session) => (
                <Link key={session.id} href={`/harvest/sessions/${session.id}`}>
                  <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <p className="font-semibold">
                              {new Date(session.date).toLocaleDateString()}
                            </p>
                            <Badge variant="outline">{session.apiaryName}</Badge>
                            <Badge variant="secondary">
                              {session.entryCount} {session.entryCount === 1 ? 'entry' : 'entries'}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <span>
                              Calculated: <strong className="text-foreground">{session.calculatedTotal.toFixed(1)} lbs</strong>
                            </span>
                            {session.totalExtractedWeight !== null && (
                              <span>
                                Actual: <strong className="text-foreground">{session.totalExtractedWeight.toFixed(1)} lbs</strong>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Harvests Tab */}
        <TabsContent value="harvests">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Harvest Records</h2>
            <Link href="/harvest/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Harvest
              </Button>
            </Link>
          </div>
          <HarvestTable harvests={harvests} />
        </TabsContent>

        {/* Inventory Tab */}
        <TabsContent value="inventory">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Jar Inventory</h2>
            <Link href="/harvest/jar">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Jars
              </Button>
            </Link>
          </div>
          {inventory.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No jars in stock. Record a jarring session to add inventory.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {inventory.map((item) => (
                <Card key={item.jarSize}>
                  <CardContent className="pt-6">
                    <div className="text-center">
                      <p className="text-3xl font-bold">{item.totalQuantity}</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {item.jarSize} jars
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Sales Tab */}
        <TabsContent value="sales">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Sales Records</h2>
            <Link href="/harvest/sell">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Record Sale
              </Button>
            </Link>
          </div>
          <SalesTable sales={sales} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
