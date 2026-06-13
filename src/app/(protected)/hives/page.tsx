import { getHives } from "@/actions/hives";
import { getApiaries } from "@/actions/apiaries";
import { HiveListView } from "@/components/hives/hive-list-view";
import { NewHiveDialog } from "@/components/hives/new-hive-dialog";

export default async function HivesPage({
  searchParams,
}: {
  searchParams: Promise<{ apiaryId?: string; status?: string; showArchived?: string }>;
}) {
  const { apiaryId, status, showArchived } = await searchParams;
  const includeArchived = showArchived === "true";
  const [hives, apiaries] = await Promise.all([
    getHives(apiaryId, status, includeArchived),
    getApiaries(),
  ]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Hives</h1>
        <NewHiveDialog
          apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
          defaultApiaryId={apiaryId}
        />
      </div>
      {hives.length === 0 ? (
        <p className="text-muted-foreground">
          No hives yet. Create your first hive to get started.
        </p>
      ) : (
        <HiveListView hives={hives} showArchived={includeArchived} />
      )}
    </div>
  );
}
