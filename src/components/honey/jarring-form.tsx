"use client";

import { useActionState } from "react";
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

const JAR_SIZES = [
  { value: "8oz", label: "8 oz" },
  { value: "1lb", label: "1 lb" },
  { value: "2lb", label: "2 lb" },
  { value: "quart", label: "Quart" },
];

interface JarringFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  harvests: { id: string; label: string }[];
  title: string;
  submitLabel: string;
}

export function JarringForm({
  action,
  harvests,
  title,
  submitLabel,
}: JarringFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form action={formAction} className="space-y-6">
          {/* Jar Size */}
          <div className="space-y-2">
            <Label htmlFor="jarSize">Jar Size *</Label>
            <Select name="jarSize" required>
              <SelectTrigger>
                <SelectValue placeholder="Select jar size" />
              </SelectTrigger>
              <SelectContent>
                {JAR_SIZES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity *</Label>
            <Input
              id="quantity"
              name="quantity"
              type="number"
              min="1"
              required
              placeholder="e.g. 12"
            />
          </div>

          {/* Linked Harvest (optional) */}
          {harvests.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="harvestId">From Harvest</Label>
              <Select name="harvestId">
                <SelectTrigger>
                  <SelectValue placeholder="None (unlinked)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (unlinked)</SelectItem>
                  {harvests.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
