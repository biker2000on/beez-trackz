"use client";

import { useState, useEffect } from "react";
import { ParsedInspection } from "@/lib/ai/transcription-parser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseTranscriptionText, confirmBatchTranscription } from "@/actions/transcription";
import { getHives } from "@/actions/hives";
import { RefreshCw, Check, Plus, X } from "lucide-react";

interface BatchReviewProps {
  mediaFileId: string;
  rawText: string;
  initialInspections: ParsedInspection[];
  onComplete: () => void;
}

interface InspectionWithMeta extends ParsedInspection {
  _id: string;
  _included: boolean;
  _selectedHiveId?: string;
}

export function BatchReview({ mediaFileId, rawText, initialInspections, onComplete }: BatchReviewProps) {
  const [inspections, setInspections] = useState<InspectionWithMeta[]>(
    initialInspections.map((insp, idx) => ({
      ...insp,
      _id: `inspection-${idx}`,
      _included: true,
    }))
  );
  const [availableHives, setAvailableHives] = useState<Array<{ id: string; positionLabel: string; apiaryName: string }>>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingHives, setIsLoadingHives] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadHives = async () => {
      try {
        const hives = await getHives(undefined, "active");
        setAvailableHives(hives);
      } catch (err) {
        console.error("Failed to load hives:", err);
        setError("Failed to load hives");
      } finally {
        setIsLoadingHives(false);
      }
    };
    loadHives();
  }, []);

  const handleReparse = async () => {
    setIsParsing(true);
    setError(null);
    try {
      const result = await parseTranscriptionText(rawText, "batch");
      if (result.inspections.length > 0) {
        setInspections(
          result.inspections.map((insp, idx) => ({
            ...insp,
            _id: `inspection-${idx}`,
            _included: true,
          }))
        );
      } else {
        setError("Failed to re-parse transcription. No inspections detected.");
      }
    } catch (err) {
      setError("Error re-parsing transcription");
      console.error(err);
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirmAll = async () => {
    const includedInspections = inspections.filter(i => i._included);

    if (includedInspections.length === 0) {
      setError("No inspections selected");
      return;
    }

    const missingHive = includedInspections.find(i => !i._selectedHiveId);
    if (missingHive) {
      setError("Please select a hive for all included inspections");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      // Map inspections to include the selected hiveId
      const inspectionsWithHiveIds = includedInspections.map(inspection => {
        const { _id, _included, _selectedHiveId, ...inspectionData } = inspection;
        return {
          ...inspectionData,
          hiveId: _selectedHiveId as string,
        };
      });

      const result = await confirmBatchTranscription(mediaFileId, inspectionsWithHiveIds);
      if (result.error) {
        setError(result.error);
      } else {
        onComplete();
      }
    } catch (err) {
      setError("Error creating inspections");
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateInspection = (id: string, updates: Partial<InspectionWithMeta>) => {
    setInspections(prev =>
      prev.map(insp => (insp._id === id ? { ...insp, ...updates } : insp))
    );
  };

  const toggleInclude = (id: string) => {
    setInspections(prev =>
      prev.map(insp => (insp._id === id ? { ...insp, _included: !insp._included } : insp))
    );
  };

  const addPest = (inspectionId: string) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const pests = insp.pests || [];
          return { ...insp, pests: [...pests, { type: "", count: "" }] };
        }
        return insp;
      })
    );
  };

  const updatePest = (inspectionId: string, pestIndex: number, field: "type" | "count", value: string) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const pests = [...(insp.pests || [])];
          pests[pestIndex] = { ...pests[pestIndex], [field]: value };
          return { ...insp, pests };
        }
        return insp;
      })
    );
  };

  const removePest = (inspectionId: string, pestIndex: number) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const pests = [...(insp.pests || [])];
          pests.splice(pestIndex, 1);
          return { ...insp, pests };
        }
        return insp;
      })
    );
  };

  const addTreatment = (inspectionId: string) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const treatments = insp.treatments || [];
          return { ...insp, treatments: [...treatments, { product: "", method: "" }] };
        }
        return insp;
      })
    );
  };

  const updateTreatment = (inspectionId: string, treatmentIndex: number, field: "product" | "method", value: string) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const treatments = [...(insp.treatments || [])];
          treatments[treatmentIndex] = { ...treatments[treatmentIndex], [field]: value };
          return { ...insp, treatments };
        }
        return insp;
      })
    );
  };

  const removeTreatment = (inspectionId: string, treatmentIndex: number) => {
    setInspections(prev =>
      prev.map(insp => {
        if (insp._id === inspectionId) {
          const treatments = [...(insp.treatments || [])];
          treatments.splice(treatmentIndex, 1);
          return { ...insp, treatments };
        }
        return insp;
      })
    );
  };

  const includedCount = inspections.filter(i => i._included).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: Raw transcription with highlights */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="raw-text">Raw Transcription (Batch Mode)</Label>
          <Textarea
            id="raw-text"
            value={rawText}
            readOnly
            className="min-h-[600px] font-mono text-sm bg-muted"
          />
          <p className="text-xs text-muted-foreground mt-2">
            {inspections.length} hive{inspections.length !== 1 ? "s" : ""} detected in transcription
          </p>
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

      {/* Right: Per-hive cards */}
      <div className="space-y-4">
        {inspections.map((inspection, idx) => (
          <Card key={inspection._id} className={!inspection._included ? "opacity-50" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`include-${inspection._id}`}
                    checked={inspection._included}
                    onCheckedChange={() => toggleInclude(inspection._id)}
                  />
                  <CardTitle className="text-base">
                    {inspection.hiveReference || `Inspection ${idx + 1}`}
                  </CardTitle>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Hive selection */}
              <div className="space-y-2">
                <Label htmlFor={`hive-select-${inspection._id}`}>Match to Hive</Label>
                <Select
                  value={inspection._selectedHiveId || ""}
                  onValueChange={(value) => updateInspection(inspection._id, { _selectedHiveId: value })}
                  disabled={!inspection._included || isLoadingHives}
                >
                  <SelectTrigger id={`hive-select-${inspection._id}`}>
                    <SelectValue placeholder={isLoadingHives ? "Loading hives..." : "Select hive"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableHives.map(hive => (
                      <SelectItem key={hive.id} value={hive.id}>
                        {hive.positionLabel} ({hive.apiaryName})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {inspection._included && (
                <>
                  {/* Queen Seen */}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`queen-seen-${inspection._id}`}
                      checked={inspection.queenSeen || false}
                      onCheckedChange={(checked) => updateInspection(inspection._id, { queenSeen: checked as boolean })}
                    />
                    <Label htmlFor={`queen-seen-${inspection._id}`} className="text-sm font-normal">
                      Queen Seen
                    </Label>
                  </div>

                  {/* Compact fields */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Honey (1-5)</Label>
                      <Input
                        type="number"
                        min="1"
                        max="5"
                        value={inspection.storesHoney || ""}
                        onChange={(e) => updateInspection(inspection._id, { storesHoney: e.target.value ? parseInt(e.target.value) : undefined })}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Pollen (1-5)</Label>
                      <Input
                        type="number"
                        min="1"
                        max="5"
                        value={inspection.storesPollen || ""}
                        onChange={(e) => updateInspection(inspection._id, { storesPollen: e.target.value ? parseInt(e.target.value) : undefined })}
                        className="h-8"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Temperament (1-5)</Label>
                    <Input
                      type="number"
                      min="1"
                      max="5"
                      value={inspection.temperament || ""}
                      onChange={(e) => updateInspection(inspection._id, { temperament: e.target.value ? parseInt(e.target.value) : undefined })}
                      className="h-8"
                    />
                  </div>

                  {/* Pests - compact */}
                  {inspection.pests && inspection.pests.length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-xs">Pests</Label>
                      {inspection.pests.map((pest, pestIdx) => (
                        <div key={pestIdx} className="flex gap-1">
                          <Input
                            value={pest.type}
                            onChange={(e) => updatePest(inspection._id, pestIdx, "type", e.target.value)}
                            placeholder="Type"
                            className="h-7 text-xs flex-1"
                          />
                          <Input
                            value={pest.count || ""}
                            onChange={(e) => updatePest(inspection._id, pestIdx, "count", e.target.value)}
                            placeholder="Count"
                            className="h-7 text-xs w-20"
                          />
                          <Button onClick={() => removePest(inspection._id, pestIdx)} variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <Button onClick={() => addPest(inspection._id)} variant="outline" size="sm" className="h-7 text-xs">
                    <Plus className="h-3 w-3 mr-1" />
                    Add Pest
                  </Button>

                  {/* Treatments - compact */}
                  {inspection.treatments && inspection.treatments.length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-xs">Treatments</Label>
                      {inspection.treatments.map((treatment, treatmentIdx) => (
                        <div key={treatmentIdx} className="flex gap-1">
                          <Input
                            value={treatment.product}
                            onChange={(e) => updateTreatment(inspection._id, treatmentIdx, "product", e.target.value)}
                            placeholder="Product"
                            className="h-7 text-xs flex-1"
                          />
                          <Button onClick={() => removeTreatment(inspection._id, treatmentIdx)} variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <Button onClick={() => addTreatment(inspection._id)} variant="outline" size="sm" className="h-7 text-xs">
                    <Plus className="h-3 w-3 mr-1" />
                    Add Treatment
                  </Button>

                  {/* Notes - compact */}
                  {inspection.notes && (
                    <div className="space-y-1">
                      <Label className="text-xs">Notes</Label>
                      <Textarea
                        value={inspection.notes}
                        onChange={(e) => updateInspection(inspection._id, { notes: e.target.value })}
                        className="min-h-[50px] text-xs"
                      />
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        ))}

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        <Card className="bg-muted">
          <CardContent className="pt-6">
            <div className="text-sm mb-3">
              <strong>Summary:</strong> Will create {includedCount} inspection{includedCount !== 1 ? "s" : ""} for {includedCount} hive{includedCount !== 1 ? "s" : ""}
            </div>
            <Button
              onClick={handleConfirmAll}
              disabled={isSubmitting || includedCount === 0}
              className="w-full"
              size="lg"
            >
              <Check className="h-5 w-5 mr-2" />
              {isSubmitting ? "Creating Inspections..." : `Confirm All (${includedCount})`}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
