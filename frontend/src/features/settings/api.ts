"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- Preferences -----------------------------------------------------------

export interface Preferences {
  displayName: string | null;
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
}

export interface PreferencesPayload {
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
}

export interface ApiaryOption {
  id: string;
  name: string;
}

export function usePreferences() {
  return useQuery({
    queryKey: ["settings", "preferences"],
    queryFn: () => api.get<Preferences>("/settings"),
  });
}

export function useApiaryOptions() {
  return useQuery({
    queryKey: ["apiaries", "options"],
    queryFn: () => api.get<ApiaryOption[]>("/apiaries"),
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PreferencesPayload) =>
      api.put<{ success: boolean }>("/settings/preferences", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "preferences"] });
    },
  });
}

// --- AI configuration ------------------------------------------------------

export const AI_PROVIDERS = ["claude", "gemini", "ollama"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AIProvider, string> = {
  claude: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
  ollama: "Ollama (local)",
};

export const AI_TASKS = [
  "transcription",
  "recommendations",
  "imageAnalysis",
  "import",
] as const;
export type AITask = (typeof AI_TASKS)[number];

export const AI_TASK_LABELS: Record<AITask, string> = {
  transcription: "Transcription",
  recommendations: "Recommendations",
  imageAnalysis: "Image analysis",
  import: "Import",
};

export interface AITaskConfig {
  provider: AIProvider;
  model?: string;
}

/** Response shape of GET /settings/ai (keys masked to booleans). */
export interface AISettings {
  transcription: AITaskConfig;
  recommendations: AITaskConfig;
  imageAnalysis: AITaskConfig;
  import: AITaskConfig;
  apiKeys: {
    hasAnthropicKey: boolean;
    hasGoogleKey: boolean;
    ollamaUrl: string;
  };
}

/** Request body of PUT /settings/ai (empty key strings keep stored keys). */
export interface AISettingsPayload {
  transcription: AITaskConfig;
  recommendations: AITaskConfig;
  imageAnalysis: AITaskConfig;
  import: AITaskConfig;
  apiKeys: {
    anthropic: string;
    google: string;
    ollamaUrl: string;
  };
}

/** POST /settings/ai/test returns failures as {error} inside a 200. */
export interface AITestResult {
  success?: boolean;
  message?: string;
  error?: string;
}

export function useAISettings() {
  return useQuery({
    queryKey: ["settings", "ai"],
    queryFn: () => api.get<AISettings>("/settings/ai"),
  });
}

export function useUpdateAISettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: AISettingsPayload) =>
      api.put<{ success: boolean }>("/settings/ai", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "ai"] });
    },
  });
}

export function useTestAIConnection() {
  return useMutation({
    mutationFn: (payload: {
      provider: AIProvider;
      apiKey?: string;
      ollamaUrl?: string;
    }) => api.post<AITestResult>("/settings/ai/test", payload),
  });
}

export function useDiscoverOllamaModels() {
  return useMutation({
    mutationFn: (baseUrl: string) =>
      api.get<{ models: string[] }>("/settings/ai/ollama-models", {
        params: { baseUrl: baseUrl || undefined },
      }),
  });
}

// --- Jar sizes -------------------------------------------------------------

export interface JarSize {
  id: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  sortOrder: number;
  isActive: boolean;
  lowStockThreshold: number;
}

export interface JarSizeUpdate {
  label?: string;
  honeyOz?: number | null;
  defaultPrice?: number | null;
  isActive?: boolean;
  lowStockThreshold?: number;
}

export function useJarSizes() {
  return useQuery({
    queryKey: ["jar-sizes", "all"],
    queryFn: () =>
      api.get<JarSize[]>("/jar-sizes", { params: { includeInactive: true } }),
  });
}

export function useCreateJarSize() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      label: string;
      honeyOz: number | null;
      defaultPrice: number | null;
      lowStockThreshold: number;
    }) => api.post<JarSize>("/jar-sizes", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jar-sizes"] });
      queryClient.invalidateQueries({ queryKey: ["honey"] });
    },
  });
}

export function useUpdateJarSize() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: JarSizeUpdate & { id: string }) =>
      api.put<{ success: boolean }>(`/jar-sizes/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jar-sizes"] });
      queryClient.invalidateQueries({ queryKey: ["honey"] });
    },
  });
}
