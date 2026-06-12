import Link from "next/link";
import { getApiaries } from "@/actions/apiaries";
import { ApiaryCard } from "@/components/apiaries/apiary-card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { NavShortcut } from "@/components/keyboard/nav-shortcut";

export default async function ApiariesPage() {
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <NavShortcut keys="n" href="/apiaries/new" description="New apiary" group="Apiaries" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Apiaries</h1>
        <Link href="/apiaries/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Apiary
          </Button>
        </Link>
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
