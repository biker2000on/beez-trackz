"use client";

import { useState } from "react";
import type { ParsedImportData } from "@/lib/import/parser";
import { confirmImport } from "@/actions/import";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MapPin, Box, Clipboard, Wrench } from "lucide-react";

interface ImportReviewProps {
  data: ParsedImportData;
  onComplete: () => void;
}

export function ImportReview({ data, onComplete }: ImportReviewProps) {
  const [editableData, setEditableData] = useState<ParsedImportData>(data);
  const [selectedApiaries, setSelectedApiaries] = useState<Set<number>>(
    new Set(data.apiaries.map((_, i) => i))
  );
  const [selectedHives, setSelectedHives] = useState<Set<number>>(
    new Set(data.hives.map((_, i) => i))
  );
  const [selectedInspections, setSelectedInspections] = useState<Set<number>>(
    new Set(data.inspections.map((_, i) => i))
  );
  const [selectedEquipment, setSelectedEquipment] = useState<Set<number>>(
    new Set(data.equipment.map((_, i) => i))
  );
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setIsImporting(true);
    setError(null);

    const filteredData: ParsedImportData = {
      apiaries: editableData.apiaries.filter((_, i) => selectedApiaries.has(i)),
      hives: editableData.hives.filter((_, i) => selectedHives.has(i)),
      inspections: editableData.inspections.filter((_, i) =>
        selectedInspections.has(i)
      ),
      equipment: editableData.equipment.filter((_, i) =>
        selectedEquipment.has(i)
      ),
    };

    const result = await confirmImport(filteredData);

    if ("error" in result && result.error) {
      setError(result.error);
    } else {
      onComplete();
    }

    setIsImporting(false);
  };

  const toggleSelection = (
    set: Set<number>,
    setter: (s: Set<number>) => void,
    index: number
  ) => {
    const newSet = new Set(set);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    setter(newSet);
  };

  const totalSelected =
    selectedApiaries.size +
    selectedHives.size +
    selectedInspections.size +
    selectedEquipment.size;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Review Import</h2>
          <p className="text-muted-foreground">
            Will import: {selectedApiaries.size} apiaries, {selectedHives.size}{" "}
            hives, {selectedInspections.size} inspections,{" "}
            {selectedEquipment.size} equipment
          </p>
        </div>
        <Button
          onClick={handleConfirm}
          disabled={isImporting || totalSelected === 0}
        >
          {isImporting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Importing...
            </>
          ) : (
            "Confirm Import"
          )}
        </Button>
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 text-destructive rounded-lg">
          <p className="font-medium">Import Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {editableData.apiaries.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">
              Apiaries ({editableData.apiaries.length})
            </h3>
          </div>
          <div className="space-y-2">
            {editableData.apiaries.map((apiary, index) => (
              <Card key={index}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedApiaries.has(index)}
                      onCheckedChange={() =>
                        toggleSelection(
                          selectedApiaries,
                          setSelectedApiaries,
                          index
                        )
                      }
                    />
                    <div className="flex-1 space-y-2">
                      <Input
                        value={apiary.name}
                        onChange={(e) => {
                          const newData = { ...editableData };
                          newData.apiaries[index].name = e.target.value;
                          setEditableData(newData);
                        }}
                        placeholder="Apiary name"
                      />
                      {apiary.notes && (
                        <Textarea
                          value={apiary.notes}
                          onChange={(e) => {
                            const newData = { ...editableData };
                            newData.apiaries[index].notes = e.target.value;
                            setEditableData(newData);
                          }}
                          placeholder="Notes"
                          rows={2}
                        />
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {editableData.hives.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Box className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">
              Hives ({editableData.hives.length})
            </h3>
          </div>
          <div className="space-y-2">
            {editableData.hives.map((hive, index) => (
              <Card key={index}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedHives.has(index)}
                      onCheckedChange={() =>
                        toggleSelection(selectedHives, setSelectedHives, index)
                      }
                    />
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <Input
                        value={hive.apiaryName}
                        onChange={(e) => {
                          const newData = { ...editableData };
                          newData.hives[index].apiaryName = e.target.value;
                          setEditableData(newData);
                        }}
                        placeholder="Apiary name"
                      />
                      <Input
                        value={hive.positionLabel}
                        onChange={(e) => {
                          const newData = { ...editableData };
                          newData.hives[index].positionLabel = e.target.value;
                          setEditableData(newData);
                        }}
                        placeholder="Position"
                      />
                      {hive.notes && (
                        <Textarea
                          value={hive.notes}
                          onChange={(e) => {
                            const newData = { ...editableData };
                            newData.hives[index].notes = e.target.value;
                            setEditableData(newData);
                          }}
                          placeholder="Notes"
                          rows={2}
                          className="col-span-2"
                        />
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {editableData.inspections.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clipboard className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">
              Inspections ({editableData.inspections.length})
            </h3>
          </div>
          <div className="space-y-2">
            {editableData.inspections.map((inspection, index) => (
              <Card key={index}>
                <CardHeader className="pb-2">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedInspections.has(index)}
                      onCheckedChange={() =>
                        toggleSelection(
                          selectedInspections,
                          setSelectedInspections,
                          index
                        )
                      }
                    />
                    <CardTitle className="text-sm">
                      {inspection.hiveReference} -{" "}
                      {new Date(inspection.date).toLocaleDateString()}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {inspection.notes && (
                    <p className="text-sm text-muted-foreground">
                      {inspection.notes}
                    </p>
                  )}
                  {inspection.broodPattern && (
                    <p className="text-sm">
                      <span className="font-medium">Brood:</span>{" "}
                      {inspection.broodPattern}
                    </p>
                  )}
                  {inspection.queenSeen !== undefined && (
                    <p className="text-sm">
                      <span className="font-medium">Queen seen:</span>{" "}
                      {inspection.queenSeen ? "Yes" : "No"}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {editableData.equipment.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">
              Equipment ({editableData.equipment.length})
            </h3>
          </div>
          <div className="space-y-2">
            {editableData.equipment.map((equip, index) => (
              <Card key={index}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedEquipment.has(index)}
                      onCheckedChange={() =>
                        toggleSelection(
                          selectedEquipment,
                          setSelectedEquipment,
                          index
                        )
                      }
                    />
                    <div className="flex-1">
                      <p className="font-medium">
                        {equip.type}{" "}
                        {equip.frameCapacity && `(${equip.frameCapacity} frames)`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {equip.hiveReference}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
