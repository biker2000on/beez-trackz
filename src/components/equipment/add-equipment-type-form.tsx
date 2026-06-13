"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createEquipmentType } from "@/actions/equipment-v2";
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

export function AddEquipmentTypeForm() {
  const [state, formAction, isPending] = useActionState(createEquipmentType, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const [category, setCategory] = useState("accessory");
  const errorMessage = state && typeof state === "object" && "error" in state
    ? (state as { error: string }).error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add Equipment Type</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && <p className="text-destructive text-sm mb-2">{errorMessage}</p>}
        <form ref={formRef} action={formAction} className="flex gap-2 items-end flex-wrap">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">Name</Label>
            <Input name="name" placeholder="e.g. Pollen Trap" required />
          </div>
          <div className="w-32 space-y-1">
            <Label className="text-xs">Category</Label>
            <Select name="category" defaultValue="accessory" onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="box">Box</SelectItem>
                <SelectItem value="cover">Cover</SelectItem>
                <SelectItem value="bottom">Bottom</SelectItem>
                <SelectItem value="accessory">Accessory</SelectItem>
                <SelectItem value="frame">Frame</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {category === "box" && (
            <div className="w-32 space-y-1">
              <Label className="text-xs">Frames/Box</Label>
              <Input name="framesPerBox" type="number" min="1" placeholder="e.g. 10" />
            </div>
          )}
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "..." : "Add"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
