import { notFound } from "next/navigation";
import {
  getHarvestSession,
  addHarvestEntry,
  trueUpHarvestSession,
  deleteHarvestEntry,
} from "@/actions/harvest-sessions";
import { getHivesForApiary } from "@/actions/hives";
import { HarvestEntryForm } from "@/components/honey/harvest-entry-form";
import { TrueUpForm } from "@/components/honey/true-up-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function HarvestSessionPage({ params }: PageProps) {
  const { id } = await params;
  const session = await getHarvestSession(id);

  if (!session) {
    notFound();
  }

  const hives = await getHivesForApiary(session.apiaryId);

  const boundAddEntry = addHarvestEntry.bind(null, id);
  const boundTrueUp = trueUpHarvestSession.bind(null, id);

  return (
    <div className="container max-w-4xl py-8">
      <h1 className="mb-2 text-3xl font-bold">
        Harvest Session - {new Date(session.date).toLocaleDateString()}
      </h1>
      {session.notes && (
        <p className="mb-6 text-muted-foreground">{session.notes}</p>
      )}

      {/* Summary Cards */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Calculated Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {session.calculatedTotal.toFixed(1)} lbs
            </div>
            <p className="text-xs text-muted-foreground">
              Sum of {session.entries.length} entries
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Actual Extracted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {session.totalExtractedWeight
                ? `${session.totalExtractedWeight.toFixed(1)} lbs`
                : "Not set"}
            </div>
            <p className="text-xs text-muted-foreground">
              True-up weight
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Difference/Losses</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {session.difference !== null
                ? `${session.difference.toFixed(1)} lbs`
                : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">
              {session.difference !== null && session.difference > 0
                ? "Over-calculated"
                : session.difference !== null && session.difference < 0
                ? "Losses in processing"
                : "Set true-up to calculate"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Entries List */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Harvest Entries</CardTitle>
        </CardHeader>
        <CardContent>
          {session.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No entries yet. Add entries below.
            </p>
          ) : (
            <div className="space-y-2">
              {session.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex-1">
                    <div className="font-medium">{entry.hiveName}</div>
                    <div className="text-sm text-muted-foreground">
                      Before: {entry.superWeightBefore.toFixed(1)} lbs, After:{" "}
                      {entry.superWeightAfter.toFixed(1)} lbs
                    </div>
                    {entry.notes && (
                      <div className="text-sm text-muted-foreground">
                        {entry.notes}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary">
                      {entry.calculatedHoneyWeight.toFixed(1)} lbs
                    </Badge>
                    <form
                      action={async () => {
                        "use server";
                        await deleteHarvestEntry(entry.id, id);
                      }}
                    >
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Add Entry Form */}
        <HarvestEntryForm
          action={boundAddEntry}
          hives={hives.map((h) => ({ id: h.id, positionLabel: h.positionLabel }))}
        />

        {/* True-Up Form */}
        <TrueUpForm
          action={boundTrueUp}
          currentTotal={session.calculatedTotal}
          currentTrueUp={session.totalExtractedWeight}
        />
      </div>
    </div>
  );
}
