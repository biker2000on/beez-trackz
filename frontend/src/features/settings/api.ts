"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- Preferences -----------------------------------------------------------

export const NTFY_EVENT_KINDS = [
  "mite_check_due",
  "feeder_empty",
  "treatment_off_date",
  "flow_started",
] as const;
export type NtfyEventKind = (typeof NTFY_EVENT_KINDS)[number];

export const NTFY_EVENT_LABELS: Record<NtfyEventKind, string> = {
  mite_check_due: "Mite check due",
  feeder_empty: "Feeder empty",
  treatment_off_date: "Treatment off-date",
  flow_started: "Flow started",
};

export interface NtfySettings {
  serverUrl: string;
  topic: string;
  /** Whether a token is stored. The token itself is never returned (same
   * masked pattern as AISettings.apiKeys). */
  hasAccessToken?: boolean;
  enabled: boolean;
  eventKinds: NtfyEventKind[];
}

/** PUT /settings/ntfy: omit accessToken to keep the stored one, send "" to
 * clear it, send a value to replace it. */
export type NtfyPayload = Omit<NtfySettings, "hasAccessToken"> & {
  accessToken?: string;
};

export interface Preferences {
  displayName: string | null;
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
  units: "metric" | "us" | null;
  temperatureUnit: "c" | "f" | null;
  laborTrackingEnabled: boolean;
  miteThresholdPer100: number | null;
  miteThresholdPerDay: number | null;
  miteCheckIntervalDays: number | null;
  moistureThresholdPct: number | null;
  ntfy: NtfySettings;
}

export interface PreferencesPayload {
  theme: string;
  defaultApiaryId: string | null;
  dateFormat: string;
  weightUnit: string;
  units?: "metric" | "us" | null;
  temperatureUnit?: "c" | "f" | "" | null;
  laborTrackingEnabled?: boolean;
  miteThresholdPer100?: number | null;
  miteThresholdPerDay?: number | null;
  miteCheckIntervalDays?: number | null;
  moistureThresholdPct?: number | null;
}

export interface ApiaryOption {
  id: string;
  name: string;
}

export function usePreferences(enabled = true) {
  return useQuery({
    queryKey: ["settings", "preferences"],
    queryFn: () => api.get<Preferences>("/settings"),
    enabled,
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
      // The whole ops group: units display AND the labor widget's enabled
      // flag, which this form toggles.
      queryClient.invalidateQueries({ queryKey: ["ops"] });
    },
  });
}

export function useUpdateNtfy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NtfyPayload) =>
      api.put<{ success: boolean }>("/settings/ntfy", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "preferences"] });
    },
  });
}

export function useTestNtfy() {
  return useMutation({
    mutationFn: () =>
      api.post<{ success?: boolean; error?: string }>("/ops/ntfy/test"),
  });
}

export function useDispatchNtfy() {
  return useMutation({
    mutationFn: () =>
      api.post<{
        published: number;
        skipped: number;
        errors: string[];
        reason?: string;
      }>("/ops/ntfy/dispatch"),
  });
}

export interface LaborSession {
  id: string;
  apiaryId: string | null;
  apiaryName: string | null;
  startedAt: string;
  stoppedAt: string | null;
  minutes: number;
  notes: string | null;
  open: boolean;
}

export function useLaborCurrent() {
  return useQuery({
    queryKey: ["ops", "labor", "current"],
    queryFn: () =>
      api.get<{ enabled: boolean; current: LaborSession | null }>(
        "/ops/labor/current",
      ),
  });
}

export function useLaborList() {
  return useQuery({
    queryKey: ["ops", "labor"],
    queryFn: () => api.get<{ items: LaborSession[] }>("/ops/labor"),
  });
}

export function useLaborStart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload?: { apiaryId?: string | null; notes?: string }) =>
      api.post<LaborSession>("/ops/labor/start", payload ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops", "labor"] });
    },
  });
}

export function useLaborStop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload?: { id?: string; notes?: string }) =>
      api.post<LaborSession>("/ops/labor/stop", payload ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops", "labor"] });
    },
  });
}

// --- AI configuration ------------------------------------------------------

export const AI_PROVIDERS = ["claude", "gemini", "ollama", "whisper"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AIProvider, string> = {
  claude: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
  ollama: "Ollama (local)",
  whisper: "Whisper (local)",
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
    whisperUrl: string;
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
    whisperUrl: string;
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
      whisperUrl?: string;
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
  /** Required to deactivate a size with jars still on hand (API 409s otherwise). */
  writeOffRemaining?: boolean;
  writeOffReason?: string;
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

export interface TreatmentProduct {
  id: string;
  name: string;
  aliases: string[];
  withdrawalDays: number;
  notes: string | null;
}

export function useTreatmentProducts() {
  return useQuery({
    queryKey: ["treatment-products"],
    queryFn: () => api.get<TreatmentProduct[]>("/treatment-products"),
  });
}

export function useUpdateTreatmentProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, withdrawalDays }: { id: string; withdrawalDays: number }) =>
      api.patch<{ success: boolean }>(`/treatment-products/${id}`, { withdrawalDays }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["treatment-products"] });
      queryClient.invalidateQueries({ queryKey: ["hives"] });
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

// --- GnuCash (folio) sync --------------------------------------------------
//
// Beez pushes sales and expenses into a GnuCash book and pulls back only
// enough to notice that someone edited them there. The browser never talks to
// folio: the base URL and token live server-side, and every call below goes
// through the beez API.

export interface GnuCashAccount {
  guid: string;
  name: string;
  fullName: string;
  type: string;
  commodityMnemonic: string;
  placeholder: boolean;
  hidden: boolean;
}

/** Folio account GUIDs keyed by what they fund. */
export interface GnuCashAccountMapping {
  /** One revenue account per sale-line kind. */
  revenue?: Record<string, string>;
  /** One expense account per expenses.category. */
  expenses?: Record<string, string>;
  cash?: string;
  accountsReceivable?: string;
  salesTax?: string;
  discount?: string;
  /** COGS and inventory are an optional pair — map both or neither. */
  cogs?: string;
  inventory?: string;
}

export interface GnuCashSettings {
  baseUrl: string;
  /** The stored token is never returned, only whether one exists. */
  hasToken: boolean;
  bookGuid: string;
  bookName: string;
  rootCurrency: string;
  syncEnabled: boolean;
  accountMapping: GnuCashAccountMapping;
  lastSyncedAt: string | null;
  hasCursor: boolean;
  /** Kinds and categories come from the server so the editor cannot drift
   * from the database CHECK lists. */
  saleLineKinds: string[];
  expenseCategories: string[];
}

/** PUT /settings/gnucash: omit apiToken to keep the stored one, "" to clear. */
export interface GnuCashSettingsPayload {
  baseUrl?: string;
  apiToken?: string;
  syncEnabled?: boolean;
  accountMapping?: GnuCashAccountMapping;
}

export interface GnuCashTestResult {
  success?: boolean;
  bookGuid?: string;
  bookName?: string;
  rootCurrency?: string;
  error?: string;
}

export interface GnuCashRow {
  id: string;
  entityType: string;
  entityId: string;
  externalId: string;
  syncState: string;
  conflictState: string;
  lastError: string;
  lastSyncedAt: string | null;
  remoteEnterDate: string | null;
  summary: string;
}

export interface GnuCashRows {
  counts: Record<string, number>;
  conflicts: GnuCashRow[];
  failures: GnuCashRow[];
}

export interface GnuCashSyncReport {
  scanned: number;
  created: number;
  updated: number;
  retired: number;
  failed: number;
  skipped: number;
  pulledItems: number;
  conflicts: number;
  errors: string[];
}

export function useGnuCashSettings() {
  return useQuery({
    queryKey: ["settings", "gnucash"],
    queryFn: () => api.get<GnuCashSettings>("/settings/gnucash"),
  });
}

export function useUpdateGnuCashSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: GnuCashSettingsPayload) =>
      api.put<{ success: boolean }>("/settings/gnucash", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

export function useTestGnuCashConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<GnuCashTestResult>("/settings/gnucash/test"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

/** The account list is fetched from folio on demand, not on every render. */
export function useGnuCashAccounts(enabled: boolean) {
  return useQuery({
    queryKey: ["settings", "gnucash", "accounts"],
    queryFn: () =>
      api.get<{ accounts: GnuCashAccount[] }>("/settings/gnucash/accounts"),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useGnuCashRows() {
  return useQuery({
    queryKey: ["settings", "gnucash", "rows"],
    queryFn: () => api.get<GnuCashRows>("/settings/gnucash/rows"),
  });
}

export function useRunGnuCashSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<GnuCashSyncReport>("/settings/gnucash/sync"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

export function usePushGnuCashRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<GnuCashSyncReport>(`/settings/gnucash/rows/${id}/push`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}

export function useIgnoreGnuCashRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/settings/gnucash/rows/${id}/ignore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "gnucash"] });
    },
  });
}
