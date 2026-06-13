import { getApiaries } from "@/actions/apiaries";
import { ApiaryCard } from "@/components/apiaries/apiary-card";
import { NewApiaryDialog } from "@/components/apiaries/new-apiary-dialog";

export default async function ApiariesPage() {
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Apiaries</h1>
        <NewApiaryDialog />
      </div>
      {apiaries.length === 0 ? (
        <p className="text-muted-foreground">
          No apiaries yet. Create your first apiary to get started.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {apiaries.map((apiary) => (
            <ApiaryCard
              key={apiary.id}
              id={apiary.id}
              name={apiary.name}
              latitude={apiary.latitude}
              longitude={apiary.longitude}
              hiveCount={Number(apiary.hiveCount)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
