"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { PestInput } from "./pest-input";
import { TreatmentInput } from "./treatment-input";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface PestRow {
  type: string;
  count: number;
}

interface TreatmentRow {
  product: string;
  method: string;
  dateApplied: string;
  dateToRemove: string;
}

interface InspectionFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  defaultValues?: {
    date?: Date | null;
    inspectorName?: string | null;
    queenSeen?: boolean | null;
    queenHealth?: string | null;
    broodPattern?: string | null;
    storesHoney?: number | null;
    storesPollen?: number | null;
    temperament?: number | null;
    pests?: PestRow[] | null;
    treatments?: TreatmentRow[] | null;
    notes?: string | null;
  };
  hiveId: string;
  title: string;
  submitLabel: string;
  embedded?: boolean;
}

const RATING_OPTIONS = [
  { value: "1", label: "1 - Very Low" },
  { value: "2", label: "2 - Low" },
  { value: "3", label: "3 - Average" },
  { value: "4", label: "4 - Good" },
  { value: "5", label: "5 - Excellent" },
];

const TEMPERAMENT_OPTIONS = [
  { value: "1", label: "1 - Very Aggressive" },
  { value: "2", label: "2 - Aggressive" },
  { value: "3", label: "3 - Moderate" },
  { value: "4", label: "4 - Calm" },
  { value: "5", label: "5 - Very Calm" },
];

export function InspectionForm({
  action,
  defaultValues,
  hiveId,
  title,
  submitLabel,
  embedded = false,
}: InspectionFormProps) {
  const [state, formAction, isPending] = useServerActionForm(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const dateValue = defaultValues?.date
    ? new Date(defaultValues.date).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  const content = (
    <>
      {!embedded && (
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      )}
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form ref={formRef} onSubmit={formAction} className="space-y-6">
          <input type="hidden" name="hiveId" value={hiveId} />
          <input
            type="hidden"
            name="queenSeen"
            value={defaultValues?.queenSeen ? "true" : "false"}
          />

          {/* Section 1: Basics */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Basics
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="date">Date *</Label>
                <Input
                  id="date"
                  name="date"
                  type="date"
                  required
                  defaultValue={dateValue}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inspectorName">Inspector</Label>
                <Input
                  id="inspectorName"
                  name="inspectorName"
                  placeholder="Inspector name"
                  defaultValue={defaultValues?.inspectorName ?? ""}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Section 2: Queen */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Queen
            </h3>
            <QueenSeenToggle
              defaultChecked={defaultValues?.queenSeen ?? false}
            />
            <div className="space-y-2">
              <Label htmlFor="queenHealth">Queen Health</Label>
              <Input
                id="queenHealth"
                name="queenHealth"
                placeholder="e.g. Laying well, spotted on frame 4"
                defaultValue={defaultValues?.queenHealth ?? ""}
              />
            </div>
          </div>

          <Separator />

          {/* Section 3: Brood & Stores */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Brood & Stores
            </h3>
            <div className="space-y-2">
              <Label htmlFor="broodPattern">Brood Pattern</Label>
              <Input
                id="broodPattern"
                name="broodPattern"
                placeholder="e.g. Solid, spotty, good coverage"
                defaultValue={defaultValues?.broodPattern ?? ""}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="storesHoney">Honey Stores</Label>
                <Select
                  name="storesHoney"
                  defaultValue={
                    defaultValues?.storesHoney?.toString() || "__none__"
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="1-5" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not rated</SelectItem>
                    {RATING_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="storesPollen">Pollen Stores</Label>
                <Select
                  name="storesPollen"
                  defaultValue={
                    defaultValues?.storesPollen?.toString() || "__none__"
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="1-5" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not rated</SelectItem>
                    {RATING_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="temperament">Temperament</Label>
                <Select
                  name="temperament"
                  defaultValue={
                    defaultValues?.temperament?.toString() || "__none__"
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="1-5" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not rated</SelectItem>
                    {TEMPERAMENT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <Separator />

          {/* Section 4: Pests */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Pests
            </h3>
            <PestInput
              defaultValue={
                (defaultValues?.pests as PestRow[] | undefined) ?? []
              }
            />
          </div>

          <Separator />

          {/* Section 5: Treatments */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Treatments
            </h3>
            <TreatmentInput
              defaultValue={
                (defaultValues?.treatments as TreatmentRow[] | undefined) ?? []
              }
            />
          </div>

          <Separator />

          {/* Section 6: Notes */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Notes
            </h3>
            <Textarea
              id="notes"
              name="notes"
              rows={4}
              placeholder="Additional observations, weather conditions, etc."
              defaultValue={defaultValues?.notes ?? ""}
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </>
  );

  if (embedded) {
    return <div>{content}</div>;
  }

  return (
    <Card className="max-w-2xl mx-auto">
      {content}
    </Card>
  );
}

/**
 * Client-side toggle that updates the hidden queenSeen input.
 */
function QueenSeenToggle({
  defaultChecked,
}: {
  defaultChecked: boolean | null;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-input"
        defaultChecked={defaultChecked ?? false}
        onChange={(e) => {
          // Update the hidden input value
          const form = e.target.closest("form");
          if (form) {
            const hidden = form.querySelector(
              'input[name="queenSeen"]'
            ) as HTMLInputElement;
            if (hidden) {
              hidden.value = e.target.checked ? "true" : "false";
            }
          }
        }}
      />
      <span className="text-sm">Queen Seen</span>
    </label>
  );
}
