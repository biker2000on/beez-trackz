"use client";

import { useState, useEffect, useTransition } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";
import { deployEquipment, getEquipmentStock } from "@/actions/equipment-v2";
import { useRouter } from "next/navigation";

interface StockItem {
  id: string;
  typeId: string;
  typeName: string;
  typeCategory: string;
  totalOwned: number;
  deployed: number;
  available: number;
  storageLocation: string | null;
  notes: string | null;
}

interface EquipmentDeployModalProps {
  hiveId: string;
}

export function EquipmentDeployModal({ hiveId }: EquipmentDeployModalProps) {
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [selectedStockId, setSelectedStockId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Load stock when dialog opens
  useEffect(() => {
    if (open) {
      getEquipmentStock().then(setStock).catch(() => setStock([]));
    }
  }, [open]);

  const availableStock = stock.filter(s => s.available > 0);
  const selectedItem = stock.find(s => s.id === selectedStockId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedStockId) {
      setError("Please select equipment");
      return;
    }

    const formData = new FormData();
    formData.set("stockId", selectedStockId);
    formData.set("hiveId", hiveId);
    formData.set("quantity", quantity);
    formData.set("notes", notes);

    startTransition(async () => {
      const result = await deployEquipment(null, formData);
      if (result && typeof result === "object" && "error" in result) {
        setError((result as { error: string }).error);
      } else {
        setOpen(false);
        setSelectedStockId("");
        setQuantity("1");
        setNotes("");
        router.refresh();
      }
    });
  };

  // Group stock by category
  const categories = [...new Set(availableStock.map(s => s.typeCategory))];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Equipment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy Equipment to Hive</DialogTitle>
        </DialogHeader>

        {error && (
          <p className="text-destructive text-sm">{error}</p>
        )}

        {availableStock.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">
            No equipment available in inventory. Add stock in Settings → Equipment first.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Equipment</Label>
              <Select value={selectedStockId} onValueChange={setSelectedStockId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select equipment..." />
                </SelectTrigger>
                <SelectContent>
                  {categories.map(cat => (
                    <div key={cat}>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
                        {cat}
                      </div>
                      {availableStock.filter(s => s.typeCategory === cat).map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.typeName} ({item.available} available)
                        </SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                min="1"
                max={selectedItem?.available || 999}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {selectedItem && (
                <p className="text-xs text-muted-foreground">
                  {selectedItem.available} available in stock
                  {selectedItem.storageLocation && ` (${selectedItem.storageLocation})`}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. newly painted, used"
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={isPending || !selectedStockId}>
                {isPending ? "Deploying..." : "Deploy Equipment"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
