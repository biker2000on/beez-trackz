import { Hexagon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function PagePlaceholder({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <Card>
        <CardHeader className="items-center py-10 text-center">
          <Hexagon className="mb-2 size-10 text-primary/40" />
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            {description ?? `The ${title} page is being built.`}
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
