import Link from "next/link";
import { getHives } from "@/actions/hives";
import { HiveCard } from "@/components/hives/hive-card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default async function HivesPage({
  searchParams,
}: {
  searchParams: Promise<{ apiaryId?: string; status?: string }>;
}) {
  const { apiaryId, status } = await searchParams;
  const hives = await getHives(apiaryId, status);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Hives</h1>
        <Link
          href={apiaryId ? `/hives/new?apiaryId=${apiaryId}` : "/hives/new"}
        >
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Hive
          </Button>
        </Link>
      </div>
      {hives.length === 0 ? (
        <p className="text-muted-foreground">
          No hives yet. Create your first hive to get started.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {hives.map((hive) => (
            <HiveCard
              key={hive.id}
              id={hive.id}
              positionLabel={hive.positionLabel}
              status={hive.status}
              apiaryName={hive.apiaryName}
              installedDate={hive.installedDate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
