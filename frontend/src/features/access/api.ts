"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type ApiaryRole = "viewer" | "editor";

export interface AccessMembership {
  apiaryId: string;
  apiaryName: string;
  role: ApiaryRole;
}

export interface AccessProfile {
  id: string;
  displayName: string;
  email: string | null;
  username?: string | null;
  isAdmin: boolean;
  hasPassword?: boolean;
  memberships: AccessMembership[];
}

export interface AccessUser extends AccessProfile {
  isActive: boolean;
  isPending: boolean;
  createdAt: string;
}

export interface AccessUserPayload {
  displayName: string;
  email: string;
  isActive?: boolean;
  memberships: Array<{ apiaryId: string; role: ApiaryRole }>;
}

export interface AccessToken {
  id: string;
  name: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function useAccessProfile() {
  return useQuery({
    queryKey: ["access", "me"],
    queryFn: () => api.get<AccessProfile>("/access/me"),
    staleTime: 60_000,
  });
}

export function useAccessUsers(enabled = true) {
  return useQuery({
    queryKey: ["access", "users"],
    queryFn: () => api.get<AccessUser[]>("/access/users"),
    enabled,
  });
}

export function useCreateAccessUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: AccessUserPayload) =>
      api.post<AccessUser>("/access/users", payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["access", "users"] }),
  });
}

export function useUpdateAccessUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: AccessUserPayload;
    }) => api.put<AccessUser>(`/access/users/${id}`, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["access", "users"] }),
  });
}

export function useDeactivateAccessUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/access/users/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["access", "users"] }),
  });
}

export function useAccessTokens() {
  return useQuery({
    queryKey: ["access", "tokens"],
    queryFn: () => api.get<AccessToken[]>("/access/tokens"),
  });
}

export function useCreateAccessToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<AccessToken & { token: string }>("/access/tokens", { name }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["access", "tokens"] }),
  });
}

export function useDeleteAccessToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/access/tokens/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["access", "tokens"] }),
  });
}

export function apiaryRole(
  profile: AccessProfile | undefined,
  apiaryId: string,
): ApiaryRole | "admin" | null {
  if (!profile) return null;
  if (profile.isAdmin) return "admin";
  return (
    profile.memberships.find((membership) => membership.apiaryId === apiaryId)
      ?.role ?? null
  );
}
