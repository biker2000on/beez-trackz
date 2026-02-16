"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

interface DeleteButtonProps {
  onDelete: () => Promise<void>;
  entityName: string;
  warning?: string;
  variant?: "ghost" | "destructive" | "outline";
  size?: "sm" | "default" | "icon";
  iconOnly?: boolean;
}

export function DeleteButton({
  onDelete,
  entityName,
  warning,
  variant = "ghost",
  size = "icon",
  iconOnly = true,
}: DeleteButtonProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} className={iconOnly ? "text-muted-foreground hover:text-destructive" : ""}>
          <Trash2 className="h-4 w-4" />
          {!iconOnly && <span className="ml-2">Delete</span>}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {warning || `This will permanently delete this ${entityName.toLowerCase()}. This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              setIsDeleting(true);
              await onDelete();
              setIsDeleting(false);
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
