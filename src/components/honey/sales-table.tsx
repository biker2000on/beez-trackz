import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface SaleItem {
  jarSize: string;
  quantity: number;
  pricePerUnit: number;
}

interface SaleEntry {
  id: string;
  date: Date;
  customerName: string | null;
  items: unknown;
  totalAmount: number;
  notes: string | null;
}

interface SalesTableProps {
  sales: SaleEntry[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatItems(items: unknown): SaleItem[] {
  if (Array.isArray(items)) return items as SaleItem[];
  if (typeof items === "string") {
    try {
      return JSON.parse(items) as SaleItem[];
    } catch {
      return [];
    }
  }
  return [];
}

export function SalesTable({ sales }: SalesTableProps) {
  if (sales.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-8">
        No sales recorded yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Items</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sales.map((sale) => {
          const items = formatItems(sale.items);
          return (
            <TableRow key={sale.id}>
              <TableCell>{formatDate(sale.date)}</TableCell>
              <TableCell>{sale.customerName || "--"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {items.map((item, i) => (
                    <Badge key={i} variant="outline" className="text-xs">
                      {item.quantity}x {item.jarSize} @ ${item.pricePerUnit.toFixed(2)}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-right font-medium">
                ${sale.totalAmount.toFixed(2)}
              </TableCell>
              <TableCell className="max-w-[200px] truncate text-muted-foreground text-xs">
                {sale.notes || "--"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
