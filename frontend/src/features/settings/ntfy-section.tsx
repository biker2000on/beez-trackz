"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import {
  NTFY_EVENT_KINDS,
  NTFY_EVENT_LABELS,
  useDispatchNtfy,
  usePreferences,
  useTestNtfy,
  useUpdateNtfy,
  type NtfyEventKind,
  type NtfyPayload,
  type NtfySettings,
  type Preferences,
} from "./api";

const EMPTY_NTFY: NtfySettings = {
  serverUrl: "",
  topic: "",
  enabled: false,
  eventKinds: [],
};

export function NtfySection() {
  const prefs = usePreferences();
  const queryClient = useQueryClient();
  const update = useUpdateNtfy();
  const test = useTestNtfy();
  const dispatch = useDispatchNtfy();
  // The stored token is never returned by the API; this is only the draft of
  // a replacement, kept out of the query cache.
  const [tokenDraft, setTokenDraft] = useState("");

  if (prefs.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load ntfy settings.
      </p>
    );
  }
  if (prefs.isLoading || !prefs.data) {
    return <Skeleton className="h-40 w-full" />;
  }

  const data = prefs.data;
  const ntfy: NtfySettings = {
    ...EMPTY_NTFY,
    ...data.ntfy,
    eventKinds: data.ntfy?.eventKinds ?? [],
  };

  function save(next: NtfyPayload) {
    const { accessToken, ...display } = next;
    queryClient.setQueryData<Preferences>(["settings", "preferences"], {
      ...data,
      ntfy: {
        ...display,
        hasAccessToken:
          accessToken === undefined
            ? ntfy.hasAccessToken
            : accessToken !== "",
      },
    });
    update.mutate(next, {
      onSuccess: () => toast.success("ntfy settings saved"),
      onError: (error) => {
        queryClient.setQueryData(["settings", "preferences"], data);
        toast.error(
          error instanceof ApiError ? error.message : "Could not save ntfy settings",
        );
      },
    });
  }

  function toggleKind(kind: NtfyEventKind, on: boolean) {
    const eventKinds = on
      ? [...new Set([...ntfy.eventKinds, kind])]
      : ntfy.eventKinds.filter((item) => item !== kind);
    save({ ...ntfy, eventKinds });
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Optional phone push via ntfy. Same events as the yard queue: mite check
        due, feeder empty, treatment off-date, flow started. Unconfigured is a
        no-op — nothing is emailed.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ntfy-url">Server URL</Label>
          <Input
            id="ntfy-url"
            type="url"
            placeholder="https://ntfy.sh"
            value={ntfy.serverUrl}
            onChange={(event) =>
              queryClient.setQueryData<Preferences>(["settings", "preferences"], {
                ...data,
                ntfy: { ...ntfy, serverUrl: event.target.value },
              })
            }
            onBlur={(event) =>
              save({ ...ntfy, serverUrl: event.target.value })
            }
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ntfy-topic">Topic</Label>
          <Input
            id="ntfy-topic"
            placeholder="beez-yard"
            value={ntfy.topic}
            onChange={(event) =>
              queryClient.setQueryData<Preferences>(["settings", "preferences"], {
                ...data,
                ntfy: { ...ntfy, topic: event.target.value },
              })
            }
            onBlur={(event) => save({ ...ntfy, topic: event.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ntfy-access-token">Access token</Label>
        <div className="flex gap-2">
          <Input
            id="ntfy-access-token"
            type="password"
            autoComplete="off"
            placeholder={
              ntfy.hasAccessToken
                ? "Token saved — type to replace"
                : "Optional token for protected topics"
            }
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            onBlur={() => {
              const value = tokenDraft.trim();
              if (value === "") return;
              save({ ...ntfy, accessToken: value });
              setTokenDraft("");
            }}
          />
          {ntfy.hasAccessToken ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setTokenDraft("");
                save({ ...ntfy, accessToken: "" });
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Sent only as an Authorization bearer token when publishing (HTTPS
          server URLs only). The saved token is never shown again.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={ntfy.enabled}
          onChange={(event) =>
            save({ ...ntfy, enabled: event.target.checked })
          }
        />
        <span>Enable push for the kinds below</span>
      </label>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Event kinds</legend>
        {NTFY_EVENT_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={ntfy.eventKinds.includes(kind)}
              onChange={(event) => toggleKind(kind, event.target.checked)}
            />
            {NTFY_EVENT_LABELS[kind]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (result) => {
                if (result.success) toast.success("Test notification sent");
                else toast.error(result.error ?? "ntfy test failed");
              },
              onError: (error) =>
                toast.error(
                  error instanceof ApiError ? error.message : "ntfy test failed",
                ),
            })
          }
        >
          Send test
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={dispatch.isPending}
          onClick={() =>
            dispatch.mutate(undefined, {
              onSuccess: (result) => {
                if (result.reason) {
                  toast.message(result.reason);
                  return;
                }
                toast.success(
                  `Published ${result.published}, skipped ${result.skipped}`,
                );
                if (result.errors?.length) {
                  toast.error(result.errors.join("; "));
                }
              },
              onError: (error) =>
                toast.error(
                  error instanceof ApiError
                    ? error.message
                    : "Could not dispatch ntfy events",
                ),
            })
          }
        >
          Dispatch due events
        </Button>
      </div>
    </div>
  );
}
