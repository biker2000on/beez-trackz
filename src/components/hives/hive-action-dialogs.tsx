"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { createFeeding } from "@/actions/feedings";
import { createSplit } from "@/actions/hive-splits";
import { createInspection } from "@/actions/inspections";
import { createQueen } from "@/actions/queens";
import { FeedingForm } from "@/components/feedings/feeding-form";
import { InspectionForm } from "@/components/inspections/inspection-form";
import { QueenForm } from "@/components/queens/queen-form";
import { SplitHiveForm } from "@/components/hives/split-hive-form";
import { PhotoUpload } from "@/components/photos/photo-upload";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface TriggerProps {
  children?: ReactNode;
  variant?: "default" | "outline" | "secondary" | "ghost" | "link" | "destructive";
  size?: "default" | "sm" | "lg" | "icon";
}

interface HiveActionBaseProps extends TriggerProps {
  hiveId: string;
  hiveLabel: string;
}

function TriggerButton({
  children,
  label,
  variant = "outline",
  size = "sm",
}: TriggerProps & { label: string }) {
  return (
    <DialogTrigger asChild>
      <Button variant={variant} size={size}>
        {children ?? (
          <>
            <Plus className="h-4 w-4 mr-2" />
            {label}
          </>
        )}
      </Button>
    </DialogTrigger>
  );
}

export function NewInspectionDialog({
  hiveId,
  hiveLabel,
  children,
  variant,
  size,
}: HiveActionBaseProps) {
  const title = `New Inspection - ${hiveLabel}`;

  return (
    <Dialog>
      <TriggerButton label="New Inspection" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <InspectionForm
          action={createInspection}
          hiveId={hiveId}
          title={title}
          submitLabel="Record Inspection"
          embedded
        />
      </DialogContent>
    </Dialog>
  );
}

export function QuickInspectionDialog({
  hiveId,
  hiveLabel,
  children,
  variant,
  size,
}: HiveActionBaseProps) {
  const title = `Quick Inspection - ${hiveLabel}`;

  return (
    <Dialog>
      <TriggerButton label="Quick Inspection" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <InspectionForm
          action={createInspection}
          hiveId={hiveId}
          title={title}
          submitLabel="Save Quick Inspection"
          embedded
        />
      </DialogContent>
    </Dialog>
  );
}

export function FeedingDialog({
  hiveId,
  hiveLabel,
  children,
  variant,
  size,
}: HiveActionBaseProps) {
  const title = `Record Feeding - ${hiveLabel}`;

  return (
    <Dialog>
      <TriggerButton label="Record Feeding" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <FeedingForm
          action={createFeeding}
          hiveId={hiveId}
          title={title}
          submitLabel="Record Feeding"
          embedded
        />
      </DialogContent>
    </Dialog>
  );
}

export function AddQueenDialog({
  hiveId,
  hiveLabel,
  hives,
  queens,
  children,
  variant,
  size,
}: HiveActionBaseProps & {
  hives: { id: string; name: string }[];
  queens: { id: string; label: string }[];
}) {
  const title = `Add Queen to ${hiveLabel}`;

  return (
    <Dialog>
      <TriggerButton label="Add Queen" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <QueenForm
          action={createQueen}
          hives={hives}
          queens={queens}
          defaultValues={{ hiveId }}
          title={title}
          submitLabel="Create Queen"
          embedded
        />
      </DialogContent>
    </Dialog>
  );
}

export function SplitHiveDialog({
  hiveId,
  hiveLabel,
  apiaryId,
  apiaries,
  children,
  variant,
  size,
}: HiveActionBaseProps & {
  apiaryId: string;
  apiaries: { id: string; name: string }[];
}) {
  return (
    <Dialog>
      <TriggerButton label="Split Hive" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Split Hive - {hiveLabel}</DialogTitle>
        </DialogHeader>
        <SplitHiveForm
          action={createSplit}
          parentHiveId={hiveId}
          apiaryId={apiaryId}
          apiaries={apiaries}
          embedded
        />
      </DialogContent>
    </Dialog>
  );
}

export function HivePhotoDialog({
  hiveId,
  hiveLabel,
  children,
  variant,
  size,
}: HiveActionBaseProps) {
  return (
    <Dialog>
      <TriggerButton label="Take Photo" variant={variant} size={size}>
        {children}
      </TriggerButton>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Photo - {hiveLabel}</DialogTitle>
        </DialogHeader>
        <PhotoUpload ownerType="hive" ownerId={hiveId} />
      </DialogContent>
    </Dialog>
  );
}
