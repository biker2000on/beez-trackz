"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createBloomObservation } from "@/actions/bloom-observations";
import { Plus } from "lucide-react";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface BloomFormProps {
  apiaryId: string;
  speciesList: string[];
}

export function BloomForm({ apiaryId, speciesList }: BloomFormProps) {
  const [state, formAction, isPending] = useActionState(createBloomObservation, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const [speciesInput, setSpeciesInput] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const filtered = speciesList.filter((s) =>
    s.toLowerCase().includes(speciesInput.toLowerCase())
  );

  if (!showForm) {
    return (
      <Button size="sm" onClick={() => setShowForm(true)}>
        <Plus className="h-4 w-4 mr-2" />
        Add Bloom
      </Button>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="border rounded-lg p-4 space-y-3">
      <input type="hidden" name="apiaryId" value={apiaryId} />
      {errorMessage && (
        <p className="text-destructive text-sm">{errorMessage}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 relative">
          <Label htmlFor="species">Species *</Label>
          <Input
            id="species"
            name="species"
            value={speciesInput}
            onChange={(e) => {
              setSpeciesInput(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder="e.g. White Clover"
            required
          />
          {showSuggestions && filtered.length > 0 && speciesInput && (
            <div className="absolute z-10 top-full left-0 right-0 bg-popover border rounded-md shadow-md mt-1 max-h-32 overflow-y-auto">
              {filtered.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSpeciesInput(s);
                    setShowSuggestions(false);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="dateFirstSeen">First Seen *</Label>
          <Input
            id="dateFirstSeen"
            name="dateFirstSeen"
            type="date"
            required
            defaultValue={new Date().toISOString().split("T")[0]}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="abundance">Abundance</Label>
          <Select name="abundance" defaultValue="3">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 - Sparse</SelectItem>
              <SelectItem value="2">2 - Light</SelectItem>
              <SelectItem value="3">3 - Moderate</SelectItem>
              <SelectItem value="4">4 - Heavy</SelectItem>
              <SelectItem value="5">5 - Abundant</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" placeholder="Optional notes" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
