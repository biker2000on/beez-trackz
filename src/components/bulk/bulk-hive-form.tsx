"use client";

import { useActionState, useEffect, useState } from "react";
import { bulkCreateHives } from "@/actions/hives";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface BulkHiveFormProps {
  apiaryId: string;
}

export function BulkHiveForm({ apiaryId }: BulkHiveFormProps) {
  const [state, formAction, isPending] = useActionState(bulkCreateHives, null);
  const [quantity, setQuantity] = useState(5);
  const [startLabel, setStartLabel] = useState("");

  useEffect(() => {
    if (state?.success) {
      // Reset form after successful submission
      setQuantity(5);
      setStartLabel("");
    }
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk Add Hives</CardTitle>
        <CardDescription>
          Create multiple hives at once with sequential labels
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="apiaryId" value={apiaryId} />

          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              type="number"
              id="quantity"
              name="quantity"
              min={1}
              max={50}
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
              required
            />
            <p className="text-sm text-muted-foreground">
              Number of hives to create (1-50)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="startLabel">Label Prefix (Optional)</Label>
            <Input
              type="text"
              id="startLabel"
              name="startLabel"
              placeholder="e.g. A"
              value={startLabel}
              onChange={(e) => setStartLabel(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {startLabel
                ? `Will create: ${startLabel}1, ${startLabel}2, ${startLabel}3...`
                : "Will create: Hive 1, Hive 2, Hive 3..."}
            </p>
          </div>

          {state?.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}

          {state?.success && (
            <p className="text-sm text-green-600">
              Created {state.count} hives!
            </p>
          )}

          <Button type="submit" disabled={isPending}>
            {isPending ? "Creating..." : `Create ${quantity} Hives`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
