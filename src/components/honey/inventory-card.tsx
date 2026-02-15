import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface InventoryItem {
  jarSize: string;
  totalQuantity: number;
}

interface InventoryCardProps {
  inventory: InventoryItem[];
}

export function InventoryCard({ inventory }: InventoryCardProps) {
  const totalJars = inventory.reduce((sum, i) => sum + i.totalQuantity, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Jar Inventory</CardTitle>
      </CardHeader>
      <CardContent>
        {inventory.length === 0 ? (
          <p className="text-muted-foreground text-sm">No jars in stock</p>
        ) : (
          <div className="space-y-2">
            {inventory.map((item) => (
              <div
                key={item.jarSize}
                className="flex items-center justify-between text-sm"
              >
                <span>{item.jarSize}</span>
                <Badge variant="outline">{item.totalQuantity} jars</Badge>
              </div>
            ))}
            <div className="border-t pt-2 flex items-center justify-between text-sm font-medium">
              <span>Total</span>
              <span>{totalJars} jars</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
