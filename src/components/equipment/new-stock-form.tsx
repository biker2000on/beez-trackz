"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";
import { useState } from "react";

import { createStock } from "@/actions/equipment-v2";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface NewStockFormProps {
  types: { id: string; name: string; category: string }[];
}

export function NewStockForm({ types }: NewStockFormProps) {
  const [state, formAction, isPending] = useServerActionForm(createStock, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const [selectedTypeId, setSelectedTypeId] = useState<string>("");
  const errorMessage = state && typeof state === "object" && "error" in state
    ? (state as { error: string }).error : null;

  const selectedType = types.find(t => t.id === selectedTypeId);
  const isFrameType = selectedType?.category === "frame";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Initialize Stock</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && <p className="text-destructive text-sm mb-2">{errorMessage}</p>}
        <form ref={formRef} onSubmit={formAction} className="flex gap-2 items-end flex-wrap">
          <div className="w-48 space-y-1">
            <Label className="text-xs">Equipment Type</Label>
            <Select name="typeId" required onValueChange={setSelectedTypeId}>
              <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent>
                {types.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-24 space-y-1">
            <Label className="text-xs">Initial Qty</Label>
            <Input name="initialQuantity" type="number" min="0" defaultValue="0" />
          </div>
          {isFrameType && (
            <div className="w-32 space-y-1">
              <Label className="text-xs">Condition</Label>
              <Select name="frameCondition">
                <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="drawn">Drawn</SelectItem>
                  <SelectItem value="fresh">Fresh</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="w-40 space-y-1">
            <Label className="text-xs">Storage</Label>
            <Input name="storageLocation" placeholder="e.g. Shed" />
          </div>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "..." : "Add Stock"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
