"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api.post<{ success: boolean }>("/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
    onError: () => {
      toast.error("Logout failed — please try again.");
    },
  });

  return (
    <Button
      variant="ghost"
      className="w-full justify-start gap-3 text-muted-foreground hover:text-foreground"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
    >
      <LogOut className="size-4" />
      Log out
    </Button>
  );
}
