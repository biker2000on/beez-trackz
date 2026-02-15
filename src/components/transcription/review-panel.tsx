"use client";

import { useState } from "react";
import { ParsedInspection } from "@/lib/ai/transcription-parser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseTranscriptionText, confirmTranscription } from "@/actions/transcription";
import { RefreshCw, Check, Plus, X } from "lucide-react";

interface ReviewPanelProps {
  mediaFileId: string;
  rawText: string;
  initialInspection: ParsedInspection;
  mode: "single" | "batch";
  onComplete: () => void;
}

export function ReviewPanel({ mediaFileId, rawText, initialInspection, mode, onComplete }: ReviewPanelProps) {
  const [inspection, setInspection] = useState<ParsedInspection>(initialInspection);
  const [isParsing, setIsParsing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReparse = async () => {
    setIsParsing(true);
    setError(null);
    try {
      const result = await parseTranscriptionText(rawText, mode);
      if (result.inspections.length > 0) {
        setInspection(result.inspections[0]);
      } else {
        setError("Failed to re-parse transcription. Please edit fields manually.");
      }
    } catch (err) {
      setError("Error re-parsing transcription");
      console.error(err);
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await confirmTranscription(mediaFileId, [inspection]);
      if (result.error) {
        setError(result.error);
      } else {
        onComplete();
      }
    } catch (err) {
      setError("Error creating inspection");
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateInspection = (field: keyof ParsedInspection, value: unknown) => {
    setInspection(prev => ({ ...prev, [field]: value }));
  };

  const addPest = () => {
    const pests = inspection.pests || [];
    updateInspection("pests", [...pests, { type: "", count: "" }]);
  };

  const updatePest = (index: number, field: "type" | "count", value: string) => {
    const pests = [...(inspection.pests || [])];
    pests[index] = { ...pests[index], [field]: value };
    updateInspection("pests", pests);
  };

  const removePest = (index: number) => {
    const pests = [...(inspection.pests || [])];
    pests.splice(index, 1);
    updateInspection("pests", pests);
  };

  const addTreatment = () => {
    const treatments = inspection.treatments || [];
    updateInspection("treatments", [...treatments, { product: "", method: "" }]);
  };

  const updateTreatment = (index: number, field: "product" | "method", value: string) => {
    const treatments = [...(inspection.treatments || [])];
    treatments[index] = { ...treatments[index], [field]: value };
    updateInspection("treatments", treatments);
  };

  const removeTreatment = (index: number) => {
    const treatments = [...(inspection.treatments || [])];
    treatments.splice(index, 1);
    updateInspection("treatments", treatments);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: Raw transcription */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="raw-text">Raw Transcription</Label>
          <Textarea
            id="raw-text"
            value={rawText}
            readOnly
            className="min-h-[500px] font-mono text-sm bg-muted"
          />
        </div>
        <Button
          onClick={handleReparse}
          disabled={isParsing}
          variant="outline"
          className="w-full"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isParsing ? "animate-spin" : ""}`} />
          Re-parse with AI
        </Button>
      </div>

      {/* Right: Extracted fields */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Inspection Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Queen Seen */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="queen-seen"
                checked={inspection.queenSeen || false}
                onCheckedChange={(checked) => updateInspection("queenSeen", checked)}
              />
              <Label htmlFor="queen-seen" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Queen Seen
              </Label>
            </div>

            {/* Queen Health */}
            <div className="space-y-2">
              <Label htmlFor="queen-health">Queen Health</Label>
              <Input
                id="queen-health"
                value={inspection.queenHealth || ""}
                onChange={(e) => updateInspection("queenHealth", e.target.value)}
                placeholder="e.g., Good, laying well"
              />
            </div>

            {/* Brood Pattern */}
            <div className="space-y-2">
              <Label htmlFor="brood-pattern">Brood Pattern</Label>
              <Select
                value={inspection.broodPattern || ""}
                onValueChange={(value) => updateInspection("broodPattern", value)}
              >
                <SelectTrigger id="brood-pattern">
                  <SelectValue placeholder="Select pattern" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent</SelectItem>
                  <SelectItem value="good">Good</SelectItem>
                  <SelectItem value="fair">Fair</SelectItem>
                  <SelectItem value="poor">Poor</SelectItem>
                  <SelectItem value="spotty">Spotty</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Stores - Honey */}
            <div className="space-y-2">
              <Label htmlFor="stores-honey">Honey Stores (1-5)</Label>
              <Input
                id="stores-honey"
                type="number"
                min="1"
                max="5"
                value={inspection.storesHoney || ""}
                onChange={(e) => updateInspection("storesHoney", e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="1 = Low, 5 = Excellent"
              />
            </div>

            {/* Stores - Pollen */}
            <div className="space-y-2">
              <Label htmlFor="stores-pollen">Pollen Stores (1-5)</Label>
              <Input
                id="stores-pollen"
                type="number"
                min="1"
                max="5"
                value={inspection.storesPollen || ""}
                onChange={(e) => updateInspection("storesPollen", e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="1 = Low, 5 = Excellent"
              />
            </div>

            {/* Temperament */}
            <div className="space-y-2">
              <Label htmlFor="temperament">Temperament (1-5)</Label>
              <Input
                id="temperament"
                type="number"
                min="1"
                max="5"
                value={inspection.temperament || ""}
                onChange={(e) => updateInspection("temperament", e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="1 = Calm, 5 = Aggressive"
              />
            </div>

            {/* Pests */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Pests</Label>
                <Button onClick={addPest} variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Add Pest
                </Button>
              </div>
              {inspection.pests && inspection.pests.length > 0 && (
                <div className="space-y-2">
                  {inspection.pests.map((pest, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        value={pest.type}
                        onChange={(e) => updatePest(index, "type", e.target.value)}
                        placeholder="Pest type"
                        className="flex-1"
                      />
                      <Input
                        value={pest.count || ""}
                        onChange={(e) => updatePest(index, "count", e.target.value)}
                        placeholder="Count/severity"
                        className="w-32"
                      />
                      <Button onClick={() => removePest(index)} variant="ghost" size="sm">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Treatments */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Treatments</Label>
                <Button onClick={addTreatment} variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Add Treatment
                </Button>
              </div>
              {inspection.treatments && inspection.treatments.length > 0 && (
                <div className="space-y-2">
                  {inspection.treatments.map((treatment, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        value={treatment.product}
                        onChange={(e) => updateTreatment(index, "product", e.target.value)}
                        placeholder="Product name"
                        className="flex-1"
                      />
                      <Input
                        value={treatment.method || ""}
                        onChange={(e) => updateTreatment(index, "method", e.target.value)}
                        placeholder="Method"
                        className="w-32"
                      />
                      <Button onClick={() => removeTreatment(index)} variant="ghost" size="sm">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="notes">Additional Notes</Label>
              <Textarea
                id="notes"
                value={inspection.notes || ""}
                onChange={(e) => updateInspection("notes", e.target.value)}
                placeholder="Any additional observations..."
                className="min-h-[100px]"
              />
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        <Button
          onClick={handleConfirm}
          disabled={isSubmitting}
          className="w-full"
          size="lg"
        >
          <Check className="h-5 w-5 mr-2" />
          {isSubmitting ? "Creating Inspection..." : "Confirm & Create Inspection"}
        </Button>
      </div>
    </div>
  );
}
