"use client";

import { Plus } from "lucide-react";
import { AddEquipmentTypeForm } from "@/components/equipment/add-equipment-type-form";
import { NewStockForm } from "@/components/equipment/new-stock-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function AddEquipmentTypeDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add Equipment Type
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Equipment Type</DialogTitle>
        </DialogHeader>
        <AddEquipmentTypeForm embedded />
      </DialogContent>
    </Dialog>
  );
}

export function NewStockDialog({
  types,
}: {
  types: { id: string; name: string; category: string }[];
}) {
  if (types.length === 0) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Initialize Stock
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Initialize Stock</DialogTitle>
        </DialogHeader>
        <NewStockForm types={types} embedded />
      </DialogContent>
    </Dialog>
  );
}
