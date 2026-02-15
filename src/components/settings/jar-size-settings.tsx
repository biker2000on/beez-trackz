"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { X, Plus } from "lucide-react";
import { updateJarSizes, type JarSize } from "@/actions/jar-sizes";

interface JarSizeSettingsProps {
  initialSizes: JarSize[];
}

export function JarSizeSettings({ initialSizes }: JarSizeSettingsProps) {
  const [sizes, setSizes] = useState<JarSize[]>(initialSizes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleAddSize = () => {
    setSizes([...sizes, { label: "", honeyOz: 0 }]);
  };

  const handleRemoveSize = (index: number) => {
    setSizes(sizes.filter((_, i) => i !== index));
  };

  const handleUpdateLabel = (index: number, label: string) => {
    const updated = [...sizes];
    updated[index].label = label;
    setSizes(updated);
  };

  const handleUpdateOz = (index: number, value: string) => {
    const updated = [...sizes];
    updated[index].honeyOz = parseFloat(value) || 0;
    setSizes(updated);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateJarSizes(sizes);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error("Failed to save jar sizes:", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jar Sizes</CardTitle>
        <CardDescription>
          Configure honey jar sizes and weights for harvest tracking
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {sizes.map((size, index) => (
            <div key={index} className="flex items-end gap-3">
              <div className="flex-1">
                <Label htmlFor={`label-${index}`}>Label</Label>
                <Input
                  id={`label-${index}`}
                  value={size.label}
                  onChange={(e) => handleUpdateLabel(index, e.target.value)}
                  placeholder="e.g., Pint"
                />
              </div>
              <div className="w-32">
                <Label htmlFor={`oz-${index}`}>Honey (oz)</Label>
                <Input
                  id={`oz-${index}`}
                  type="number"
                  step="0.1"
                  value={size.honeyOz}
                  onChange={(e) => handleUpdateOz(index, e.target.value)}
                  placeholder="0"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveSize(index)}
                className="shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={handleAddSize}
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Size
        </Button>

        <div className="flex items-center gap-3 pt-4">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          {saved && (
            <span className="text-sm text-green-600 font-medium">
              Saved!
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
