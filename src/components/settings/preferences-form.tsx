"use client";

import { useActionState } from "react";
import { updatePreferences } from "@/actions/preferences";
import { Button } from "@/components/ui/button";
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

interface PreferencesFormProps {
  preferences: {
    theme?: string | null;
    defaultApiaryId?: string | null;
    dateFormat?: string | null;
    weightUnit?: string | null;
  } | null;
  apiaries: { id: string; name: string }[];
}

export function PreferencesForm({ preferences, apiaries }: PreferencesFormProps) {
  const [state, formAction, isPending] = useActionState(updatePreferences, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const errorMessage = state && typeof state === "object" && "error" in state
    ? (state as { error: string }).error
    : null;
  const successMessage = state && typeof state === "object" && "success" in state
    ? "Preferences saved!"
    : null;

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Display Preferences</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && <p className="text-destructive text-sm mb-4">{errorMessage}</p>}
        {successMessage && <p className="text-green-600 text-sm mb-4">{successMessage}</p>}
        <form ref={formRef} action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="theme">Theme</Label>
            <Select name="theme" defaultValue={preferences?.theme || "system"}>
              <SelectTrigger><SelectValue placeholder="Select theme" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultApiaryId">Default Apiary</Label>
            <Select name="defaultApiaryId" defaultValue={preferences?.defaultApiaryId || "__none__"}>
              <SelectTrigger><SelectValue placeholder="Select default apiary" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {apiaries.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dateFormat">Date Format</Label>
            <Select name="dateFormat" defaultValue={preferences?.dateFormat || "MM/DD/YYYY"}>
              <SelectTrigger><SelectValue placeholder="Select date format" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="weightUnit">Weight Unit</Label>
            <Select name="weightUnit" defaultValue={preferences?.weightUnit || "oz"}>
              <SelectTrigger><SelectValue placeholder="Select weight unit" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oz">Ounces (oz)</SelectItem>
                <SelectItem value="lbs">Pounds (lbs)</SelectItem>
                <SelectItem value="g">Grams (g)</SelectItem>
                <SelectItem value="kg">Kilograms (kg)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save Preferences"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
