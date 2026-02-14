import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin, Bug } from "lucide-react";

interface ApiaryCardProps {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  hiveCount: number;
}

export function ApiaryCard({
  id,
  name,
  latitude,
  longitude,
  hiveCount,
}: ApiaryCardProps) {
  return (
    <Link href={`/apiaries/${id}`}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{name}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4 text-sm text-muted-foreground">
          {latitude !== null && longitude !== null && (
            <span className="flex items-center gap-1">
              <MapPin className="h-4 w-4" />
              {latitude.toFixed(4)}, {longitude.toFixed(4)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Bug className="h-4 w-4" />
            {hiveCount} {hiveCount === 1 ? "hive" : "hives"}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
