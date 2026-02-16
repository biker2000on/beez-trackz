"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdjustStockDialog } from "./adjust-stock-dialog";
import { Package, Minus, Plus } from "lucide-react";

interface EquipmentStockCardProps {
  stock: {
    id: string;
    typeName: string;
    typeCategory: string;
    totalOwned: number;
    deployed: number;
    available: number;
    storageLocation: string | null;
    frameCondition?: string | null;
    framesPerBox?: number | null;
  };
}

export function EquipmentStockCard({ stock }: EquipmentStockCardProps) {
  const [showAdjust, setShowAdjust] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" />
              {stock.typeName}
            </CardTitle>
            <div className="flex gap-1">
              <Badge variant="outline" className="text-xs">{stock.typeCategory}</Badge>
              {stock.frameCondition && (
                <Badge variant="secondary" className="text-xs">{stock.frameCondition}</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2 text-center mb-3">
            <div>
              <p className="text-2xl font-bold">{stock.totalOwned}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{stock.deployed}</p>
              <p className="text-xs text-muted-foreground">Deployed</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{stock.available}</p>
              <p className="text-xs text-muted-foreground">Available</p>
            </div>
          </div>
          {stock.storageLocation && (
            <p className="text-xs text-muted-foreground mb-2">Storage: {stock.storageLocation}</p>
          )}
          {stock.framesPerBox && (
            <p className="text-xs text-muted-foreground mb-2">Frames per box: {stock.framesPerBox}</p>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAdjust(true)}>
            Adjust Stock
          </Button>
        </CardContent>
      </Card>
      <AdjustStockDialog
        stockId={stock.id}
        typeName={stock.typeName}
        open={showAdjust}
        onOpenChange={setShowAdjust}
      />
    </>
  );
}
