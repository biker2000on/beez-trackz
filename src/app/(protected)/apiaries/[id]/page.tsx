import { notFound } from "next/navigation";
import { getApiary } from "@/actions/apiaries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Pencil } from "lucide-react";

export default async function ApiaryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const apiary = await getApiary(id);

  if (!apiary) {
    notFound();
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{apiary.name}</h1>
          {apiary.notes && (
            <p className="text-muted-foreground mt-1">{apiary.notes}</p>
          )}
        </div>
        <Link href={`/apiaries/${id}/edit`}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </Link>
      </div>
      <Tabs defaultValue="hives">
        <TabsList>
          <TabsTrigger value="layout">Layout</TabsTrigger>
          <TabsTrigger value="hives">Hives</TabsTrigger>
          <TabsTrigger value="photos">Photos</TabsTrigger>
        </TabsList>
        <TabsContent value="layout">
          <p className="text-muted-foreground p-4">
            Canvas layout coming soon
          </p>
        </TabsContent>
        <TabsContent value="hives">
          <p className="text-muted-foreground p-4">
            Hive list coming in Phase 6
          </p>
        </TabsContent>
        <TabsContent value="photos">
          <p className="text-muted-foreground p-4">
            Photo gallery coming soon
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
