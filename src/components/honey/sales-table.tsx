import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface SaleLineItem {
  jarSizeId: string;
  quantity: number;
  unitPrice: number;
  label: string;
}

interface SaleEntry {
  id: string;
  date: Date;
  customerName: string | null;
  location: string | null;
  totalAmount: number;
  notes: string | null;
  lineItems: SaleLineItem[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SalesTable({ sales }: { sales: SaleEntry[] }) {
  if (sales.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-8">
        No sales recorded yet. Use Record Sale to log your first one.
      </p>
    );
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Items</TableHead>
            <TableHead className="hidden sm:table-cell">Location</TableHead>
            <TableHead className="hidden md:table-cell">Customer</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sales.map((sale) => (
            <TableRow key={sale.id}>
              <TableCell className="whitespace-nowrap">{formatDate(sale.date)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {sale.lineItems.map((item, i) => (
                    <Badge key={i} variant="secondary" className="font-normal">
                      {item.quantity} × {item.label}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-muted-foreground">
                {sale.location ?? "—"}
              </TableCell>
              <TableCell className="hidden md:table-cell text-muted-foreground">
                {sale.customerName ?? "—"}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                ${sale.totalAmount.toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
