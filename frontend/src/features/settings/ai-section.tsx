"use client";

import * as React from "react";
import { CheckCircle2, ScanSearch, XCircle } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  AI_TASKS,
  AI_TASK_LABELS,
  useAISettings,
  useDiscoverOllamaModels,
  useTestAIConnection,
  useUpdateAISettings,
  type AIProvider,
  type AISettings,
  type AITask,
} from "./api";

/** Sentinel for "use the provider's default model" in the model selects. */
const DEFAULT_MODEL = "__default__";

interface TaskDraft {
  provider: AIProvider;
  model: string;
}

interface AIDraft {
  anthropicKey: string;
  googleKey: string;
  ollamaUrl: string;
  whisperUrl: string;
  tasks: Record<AITask, TaskDraft>;
}

function draftFromSettings(settings: AISettings): AIDraft {
  const tasks = {} as Record<AITask, TaskDraft>;
  for (const task of AI_TASKS) {
    tasks[task] = {
      provider: settings[task].provider,
      model: settings[task].model ?? "",
    };
  }
  return {
    anthropicKey: "",
    googleKey: "",
    ollamaUrl: settings.apiKeys.ollamaUrl ?? "",
    whisperUrl: settings.apiKeys.whisperUrl ?? "",
    tasks,
  };
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function TestResult({ state }: { state: TestState }) {
  if (state.status === "idle") return null;
  if (state.status === "testing") {
    return <p className="text-xs text-muted-foreground">Testing connection…</p>;
  }
  return (
    <p
      className={cn(
        "flex items-center gap-1 text-xs",
        state.status === "success" ? "text-success" : "text-destructive",
      )}
      role="status"
    >
      {state.status === "success" ? (
        <CheckCircle2 className="size-3.5 shrink-0" />
      ) : (
        <XCircle className="size-3.5 shrink-0" />
      )}
      {state.message}
    </p>
  );
}

export function AISection() {
  const settings = useAISettings();
  const updateSettings = useUpdateAISettings();
  const testConnection = useTestAIConnection();
  const discoverModels = useDiscoverOllamaModels();

  const [draft, setDraft] = React.useState<AIDraft | null>(null);
  const [tests, setTests] = React.useState<Record<AIProvider, TestState>>({
    claude: { status: "idle" },
    gemini: { status: "idle" },
    ollama: { status: "idle" },
    whisper: { status: "idle" },
  });
  const [ollamaModels, setOllamaModels] = React.useState<string[] | null>(null);

  // Seed the draft once from the first successful fetch (render-time state
  // adjustment); refetches must not clobber in-progress edits.
  if (settings.data && draft === null) {
    setDraft(draftFromSettings(settings.data));
  }

  if (settings.isLoading || !draft) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load AI settings.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => settings.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  const { hasAnthropicKey, hasGoogleKey } = settings.data.apiKeys;

  function setTest(provider: AIProvider, state: TestState) {
    setTests((prev) => ({ ...prev, [provider]: state }));
  }

  async function runTest(provider: AIProvider) {
    if (!draft) return;
    setTest(provider, { status: "testing" });
    try {
      const result = await testConnection.mutateAsync({
        provider,
        apiKey:
          provider === "claude"
            ? draft.anthropicKey
            : provider === "gemini"
              ? draft.googleKey
              : undefined,
        ollamaUrl: provider === "ollama" ? draft.ollamaUrl : undefined,
        whisperUrl: provider === "whisper" ? draft.whisperUrl : undefined,
      });
      if (result.error) {
        setTest(provider, { status: "error", message: result.error });
      } else {
        setTest(provider, {
          status: "success",
          message: result.message ?? "Connection successful",
        });
      }
    } catch (error) {
      setTest(provider, {
        status: "error",
        message:
          error instanceof ApiError ? error.message : "Connection failed",
      });
    }
  }

  async function handleDiscoverModels() {
    if (!draft) return;
    try {
      const result = await discoverModels.mutateAsync(draft.ollamaUrl);
      setOllamaModels(result.models);
      if (result.models.length === 0) {
        toast.info("No Ollama models found", {
          description: "Check the Ollama URL and that models are pulled.",
        });
      } else {
        toast.success(
          `Found ${result.models.length} Ollama ${
            result.models.length === 1 ? "model" : "models"
          }`,
        );
      }
    } catch {
      toast.error("Could not reach Ollama to list models");
    }
  }

  async function handleSave() {
    if (!draft) return;
    try {
      await updateSettings.mutateAsync({
        transcription: taskPayload(draft.tasks.transcription),
        recommendations: taskPayload(draft.tasks.recommendations),
        imageAnalysis: taskPayload(draft.tasks.imageAnalysis),
        import: taskPayload(draft.tasks.import),
        apiKeys: {
          // Empty strings keep the stored keys server-side.
          anthropic: draft.anthropicKey.trim(),
          google: draft.googleKey.trim(),
          ollamaUrl: draft.ollamaUrl.trim(),
          whisperUrl: draft.whisperUrl.trim(),
        },
      });
      toast.success("AI settings saved");
      // Keys are now stored; clear the inputs so the placeholders show
      // "configured" after the refetch.
      setDraft((prev) =>
        prev ? { ...prev, anthropicKey: "", googleKey: "" } : prev,
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not save AI settings",
      );
    }
  }

  function taskPayload(task: TaskDraft) {
    return { provider: task.provider, model: task.model || undefined };
  }

  function setTask(task: AITask, patch: Partial<TaskDraft>) {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            tasks: { ...prev.tasks, [task]: { ...prev.tasks[task], ...patch } },
          }
        : prev,
    );
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="ai-anthropic-key">Anthropic API key</Label>
          <div className="flex gap-2">
            <Input
              id="ai-anthropic-key"
              type="password"
              autoComplete="off"
              placeholder={hasAnthropicKey ? "configured" : "sk-ant-…"}
              value={draft.anthropicKey}
              onChange={(e) =>
                setDraft({ ...draft, anthropicKey: e.target.value })
              }
            />
            <Button
              type="button"
              variant="outline"
              disabled={tests.claude.status === "testing"}
              onClick={() => runTest("claude")}
            >
              Test connection
            </Button>
          </div>
          {hasAnthropicKey && !draft.anthropicKey && (
            <p className="text-xs text-muted-foreground">
              A key is stored. Leave blank to keep it, or paste a new one to
              replace it.
            </p>
          )}
          <TestResult state={tests.claude} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="ai-google-key">Google API key</Label>
          <div className="flex gap-2">
            <Input
              id="ai-google-key"
              type="password"
              autoComplete="off"
              placeholder={hasGoogleKey ? "configured" : "AIza…"}
              value={draft.googleKey}
              onChange={(e) => setDraft({ ...draft, googleKey: e.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              disabled={tests.gemini.status === "testing"}
              onClick={() => runTest("gemini")}
            >
              Test connection
            </Button>
          </div>
          {hasGoogleKey && !draft.googleKey && (
            <p className="text-xs text-muted-foreground">
              A key is stored. Leave blank to keep it, or paste a new one to
              replace it.
            </p>
          )}
          <TestResult state={tests.gemini} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="ai-ollama-url">Ollama URL</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="ai-ollama-url"
              type="url"
              placeholder="http://localhost:11434"
              className="min-w-48 flex-1"
              value={draft.ollamaUrl}
              onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              disabled={tests.ollama.status === "testing"}
              onClick={() => runTest("ollama")}
            >
              Test connection
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={discoverModels.isPending}
              onClick={handleDiscoverModels}
            >
              <ScanSearch />
              {discoverModels.isPending ? "Discovering…" : "Discover models"}
            </Button>
          </div>
          <TestResult state={tests.ollama} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="ai-whisper-url">Whisper URL</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="ai-whisper-url"
              type="url"
              placeholder="http://whisper:8000"
              className="min-w-48 flex-1"
              value={draft.whisperUrl}
              onChange={(e) =>
                setDraft({ ...draft, whisperUrl: e.target.value })
              }
            />
            <Button
              type="button"
              variant="outline"
              disabled={tests.whisper.status === "testing"}
              onClick={() => runTest("whisper")}
            >
              Test connection
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Local speech-to-text (speaches / faster-whisper). Transcription
            only; the first transcription downloads the model, so it is slow.
          </p>
          <TestResult state={tests.whisper} />
        </div>
      </div>

      <Separator />

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold">Per-task providers</h3>
        <div className="grid gap-3">
          {AI_TASKS.map((task) => {
            const taskDraft = draft.tasks[task];
            const useOllamaSelect =
              taskDraft.provider === "ollama" &&
              ollamaModels !== null &&
              ollamaModels.length > 0;
            const modelOptions = useOllamaSelect
              ? Array.from(
                  new Set(
                    [taskDraft.model, ...(ollamaModels ?? [])].filter(Boolean),
                  ),
                )
              : [];
            return (
              <div
                key={task}
                className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr] sm:items-center"
              >
                <Label htmlFor={`ai-task-${task}`}>{AI_TASK_LABELS[task]}</Label>
                <Select
                  value={taskDraft.provider}
                  onValueChange={(value) =>
                    setTask(task, { provider: value as AIProvider, model: "" })
                  }
                >
                  <SelectTrigger id={`ai-task-${task}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_PROVIDERS.filter(
                      // Whisper is speech-to-text only.
                      (provider) =>
                        provider !== "whisper" || task === "transcription",
                    ).map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {AI_PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {useOllamaSelect ? (
                  <Select
                    value={taskDraft.model || DEFAULT_MODEL}
                    onValueChange={(value) =>
                      setTask(task, {
                        model: value === DEFAULT_MODEL ? "" : value,
                      })
                    }
                  >
                    <SelectTrigger aria-label={`${AI_TASK_LABELS[task]} model`}>
                      <SelectValue placeholder="Default model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL}>
                        Default model
                      </SelectItem>
                      {modelOptions.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={`${AI_TASK_LABELS[task]} model`}
                    placeholder="Default model"
                    value={taskDraft.model}
                    onChange={(e) => setTask(task, { model: e.target.value })}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={updateSettings.isPending}>
          {updateSettings.isPending ? "Saving…" : "Save AI settings"}
        </Button>
      </div>
    </div>
  );
}
