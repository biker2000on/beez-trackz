import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-200",
  dead: "bg-red-500/10 text-red-700 border-red-200",
  sold: "bg-blue-500/10 text-blue-700 border-blue-200",
  combined: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
};

interface HiveCardProps {
  id: string;
  positionLabel: string;
  status: string;
  apiaryName: string;
  installedDate: Date | null;
}

export function HiveCard({
  id,
  positionLabel,
  status,
  apiaryName,
  installedDate,
}: HiveCardProps) {
  return (
    <Link href={`/hives/${id}`}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{positionLabel}</CardTitle>
            <Badge variant="outline" className={statusColors[status] || ""}>
              {status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>{apiaryName}</p>
          {installedDate && (
            <p>
              Installed: {new Date(installedDate).toLocaleDateString()}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
