"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDeleteApiary } from "./hooks";

export function DeleteApiaryDialog({
  open,
  onOpenChange,
  apiaryId,
  apiaryName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiaryId: string;
  apiaryName: string;
}) {
  const router = useRouter();
  const deleteApiary = useDeleteApiary();

  async function onConfirm() {
    try {
      await deleteApiary.mutateAsync(apiaryId);
      toast.success("Apiary deleted");
      onOpenChange(false);
      router.push("/yard/apiaries");
    } catch (error) {
      // Surfaces the 409 guard ("Cannot delete apiary with active hives.").
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not delete the apiary",
      );
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {apiaryName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the apiary. Apiaries that still contain
            hives cannot be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
            disabled={deleteApiary.isPending}
          >
            {deleteApiary.isPending ? "Deleting…" : "Delete apiary"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
