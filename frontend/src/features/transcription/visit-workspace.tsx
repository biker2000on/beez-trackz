"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Keyboard, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, OfflineQueuedError } from "@/lib/api";
import { useAccessProfile } from "@/features/access/api";
import ApiaryCanvas from "@/features/canvas";
import { useAudioRecorder } from "./use-audio-recorder";
import {
  confirmTranscription,
  getTranscription,
  getHive,
  listApiaries,
  listHives,
  uploadTranscription,
  type ConfirmResult,
  type TranscriptionMode,
} from "./api";
import {
  listCaptures,
  saveCapture,
  type LocalCapture,
  type ReviewDraft,
} from "./capture-store";
import { VisitReview } from "./visit-review";
import { AUDIO_FILE_ACCEPT, prepareAudioFile } from "./audio-upload";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Your draft is still here.";
const localDate = (date: string) => {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

/** One persistent field workspace for apiary observations and hive inspections. */
export function VisitWorkspace({
  apiaryId: routeApiaryId,
}: {
  apiaryId?: string;
}) {
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const access = useAccessProfile();
  const [chosenApiaryId, setApiaryId] = useState(
    routeApiaryId ?? search.get("apiary") ?? "",
  );
  const [hiveId, setHiveId] = useState(search.get("hive") ?? "");
  const [mode, setMode] = useState<TranscriptionMode>(
    search.get("hive")
      ? "single"
      : search.get("scope") === "batch"
        ? "batch"
        : "apiary",
  );
  const [capture, setCapture] = useState<LocalCapture>();
  const current = useRef<LocalCapture | undefined>(undefined);
  const [journal, setJournal] = useState<LocalCapture[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [online, setOnline] = useState(true);
  const [showMap, setShowMap] = useState(search.get("view") === "map");
  const handledBlob = useRef<Blob | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const journalWrites = useRef<Promise<void>>(Promise.resolve());
  const account = useRef<string | undefined>(undefined);
  const ap = useQuery({
    queryKey: ["apiaries", "visit"],
    queryFn: listApiaries,
  });
  const hiveQuery = useQuery({
    queryKey: ["hives", "visit"],
    queryFn: listHives,
  });
  const initialHive = useQuery({
    queryKey: ["hive", "visit", search.get("hive")],
    queryFn: () => getHive(search.get("hive")!),
    enabled: Boolean(search.get("hive") && !chosenApiaryId),
  });
  const apiaryId = chosenApiaryId || initialHive.data?.apiaryId || "";
  const hives = (hiveQuery.data ?? [])
    .filter((hive) => hive.apiaryId === apiaryId && !hive.isArchived)
    .sort((a, b) =>
      a.positionLabel.localeCompare(b.positionLabel, undefined, {
        numeric: true,
      }),
    );
  const canEdit = Boolean(
    access.data?.isAdmin ||
      access.data?.memberships.some(
        (m) => m.apiaryId === apiaryId && m.role === "editor",
      ),
  );
  const selectedHive = hives.find((hive) => hive.id === hiveId);
  const nextHive = hives[hives.findIndex((hive) => hive.id === hiveId) + 1];

  const display = useCallback((value: LocalCapture | undefined) => {
    if (value && value.userId !== account.current) return;
    current.current = value;
    setCapture(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("capture", value.captureId);
    else url.searchParams.delete("capture");
    window.history.replaceState(null, "", url);
  }, []);
  function selectContext(
    selectedMode: TranscriptionMode,
    selectedHiveId: string,
  ) {
    setMode(selectedMode);
    setHiveId(selectedHiveId);
    const url = new URL(window.location.href);
    if (selectedMode === "single") {
      url.searchParams.set("hive", selectedHiveId);
      url.searchParams.delete("scope");
    } else {
      url.searchParams.delete("hive");
      url.searchParams.set("scope", selectedMode);
    }
    window.history.replaceState(null, "", url);
  }
  const persist = useCallback(
    async (value: LocalCapture, activate = true) => {
      if (activate) display(value);
      else if (value.userId === account.current) current.current = value;
      const write = journalWrites.current
        .catch(() => undefined)
        .then(() => saveCapture(value));
      journalWrites.current = write;
      await write;
      if (value.userId === account.current)
        setJournal((rows) => [
          value,
          ...rows.filter((row) => row.captureId !== value.captureId),
        ]);
    },
    [display],
  );
  const recorder = useAudioRecorder({
    onCheckpoint: async (audio) => {
      const value = current.current;
      if (value && !value.mediaFileId)
        await persist(
          {
            ...value,
            audio,
            state: "recording",
            updatedAt: new Date().toISOString(),
          },
          false,
        );
    },
  });
  const resetRecorder = recorder.reset;
  useEffect(() => {
    account.current = access.data?.id;
  }, [access.data?.id]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!access.data?.id) return;
    let active = true;
    void listCaptures(access.data.id)
      .then((rows) => {
        if (!active) return;
        setJournal(rows);
        if (current.current && current.current.userId !== access.data?.id) {
          resetRecorder();
          display(undefined);
        }
        if (current.current) return;
        const id = new URL(window.location.href).searchParams.get("capture");
        const restored = rows.find((row) => row.captureId === id);
        if (restored) {
          const ownerApiary =
            restored.ownerType === "apiary"
              ? restored.ownerId
              : hiveQuery.data?.find((hive) => hive.id === restored.ownerId)
                  ?.apiaryId;
          if (!ownerApiary && hiveQuery.isPending) return;
          if (!ownerApiary || (apiaryId && ownerApiary !== apiaryId)) {
            setError(
              "This recording belongs to another apiary. Open its original apiary to continue.",
            );
            return;
          }
          if (!apiaryId) setApiaryId(ownerApiary);
          display(restored);
          setMode(restored.mode);
          setHiveId(restored.ownerType === "hive" ? restored.ownerId : "");
          if (restored.state === "recording")
            setNotice(
              "An interrupted recording was recovered. Listen to the last saved audio before uploading; the final few seconds may be missing.",
            );
        }
      })
      .catch((err) => {
        if (active) setError(message(err));
      });
    return () => {
      active = false;
    };
  }, [
    access.data?.id,
    display,
    apiaryId,
    hiveQuery.data,
    hiveQuery.isPending,
    resetRecorder,
  ]);
  useEffect(() => {
    // Object URLs are browser resources and must be created/released together.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!capture?.audio) {
      setAudioUrl("");
      return;
    }
    const url = URL.createObjectURL(capture.audio);
    setAudioUrl(url);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => URL.revokeObjectURL(url);
  }, [capture?.audio]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (recorder.status === "recording" || busy) {
        event.preventDefault();
      }
    };
    const guardNavigation = (event: MouseEvent) => {
      if (
        recorder.status !== "recording" ||
        !(event.target instanceof Element) ||
        !event.target.closest("a[href]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setNotice("Stop and review your recording before leaving this visit.");
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [recorder.status, busy]);

  const upload = useCallback(
    async (value: LocalCapture) => {
      if (
        !value.audio ||
        value.mediaFileId ||
        uploadLock.current ||
        value.userId !== account.current
      )
        return;
      uploadLock.current = true;
      setBusy(true);
      setError("");
      try {
        // Never begin network work until the complete audio has committed locally.
        await persist(value);
        if (!navigator.onLine) {
          setNotice(
            "Recording saved on this device. Upload resumes when you reconnect.",
          );
          return;
        }
        await persist({ ...value, uploadAttempted: true });
        if (value.userId !== account.current) return;
        const result = await uploadTranscription({
          audio: value.audio,
          fileName: value.audioFileName,
          ownerType: value.ownerType,
          ownerId: value.ownerId,
          mode: value.mode,
          captureId: value.captureId,
          observedAt: value.observedAt,
          timeZone: value.timeZone,
          replacesMediaFileId: value.replacesMediaFileId,
        });
        await persist({
          ...value,
          uploadAttempted: true,
          mediaFileId: result.mediaFileId,
          state: "uploaded",
        });
        setNotice("Recording uploaded. Preparing your review…");
      } catch (err) {
        setError(message(err));
      } finally {
        uploadLock.current = false;
        setBusy(false);
      }
    },
    [persist],
  );
  useEffect(() => {
    const reconnect = () => {
      const value = current.current;
      if (
        value?.audio &&
        value.state !== "recording" &&
        !value.mediaFileId &&
        (!value.audioFileName || value.uploadAttempted)
      )
        void upload(value);
    };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [upload]);
  useEffect(() => {
    if (
      !recorder.blob ||
      handledBlob.current === recorder.blob ||
      !current.current
    )
      return;
    handledBlob.current = recorder.blob;
    void upload({
      ...current.current,
      audio: recorder.blob,
      state: "captured",
      updatedAt: new Date().toISOString(),
    });
  }, [recorder.blob, upload]);

  const transcript = useQuery({
    queryKey: ["visit-transcript", capture?.mediaFileId, capture?.mode],
    queryFn: () => getTranscription(capture!.mediaFileId!, capture!.mode),
    enabled: Boolean(capture?.mediaFileId),
    refetchInterval: (query) =>
      query.state.data?.status === "complete" ||
      query.state.data?.status === "failed"
        ? false
        : 2500,
  });
  useEffect(() => {
    const value = current.current;
    const result = transcript.data;
    if (
      !value ||
      !result ||
      result.id !== value.mediaFileId ||
      value.drafts?.length ||
      !result.parsed?.inspections.length
    )
      return;
    const drafts: ReviewDraft[] = result.parsed.inspections.map(
      (fields, index) => ({
        itemKey: fields.itemKey ?? `inspection-${index + 1}`,
        scope: fields.scope ?? (value.mode === "apiary" ? "apiary" : "hive"),
        hiveId:
          value.ownerType === "hive"
            ? value.ownerId
            : (fields.matchedHiveId ?? ""),
        fields: {
          ...fields,
          equipmentActions: fields.equipmentActions?.map((action) => ({
            ...action,
            accepted: false,
          })),
        },
      }),
    );
    void persist({
      ...value,
      drafts,
      versionId: result.currentVersionId ?? undefined,
      state: "review",
    }).catch((err) => setError(message(err)));
  }, [transcript.data, persist]);
  useEffect(() => {
    const value = current.current;
    const result = transcript.data;
    if (
      !value?.drafts?.length ||
      result?.id !== value.mediaFileId ||
      !result?.outcomes?.length
    )
      return;
    let changed = false;
    const drafts = value.drafts.map((draft) => {
      const saved = result.outcomes?.find(
        (row) => row.itemKey === draft.itemKey && row.status === "saved",
      );
      if (!saved || draft.receipt) return draft;
      changed = true;
      const receipt: ConfirmResult = {
        success: true,
        outcomes: [saved],
        inspectionIds: saved.inspectionIds ?? [],
        apiaryInspectionIds: saved.apiaryInspectionIds ?? [],
        feedingIds: saved.feedingIds ?? [],
        treatmentEventIds: saved.treatmentEventIds ?? [],
        queenEventIds: saved.queenEventIds ?? [],
        miteCountIds: saved.miteCountIds ?? [],
        operationIds: saved.operationIds ?? [],
      };
      return {
        ...draft,
        hiveId: saved.hiveId ?? draft.hiveId,
        scope: saved.scope ?? draft.scope,
        receipt,
        pending: undefined,
        queued: false,
      };
    });
    if (changed)
      void persist({
        ...value,
        drafts,
        state: drafts.every((draft) => draft.receipt) ? "saved" : "review",
      }).catch((err) => setError(message(err)));
  }, [transcript.data, persist]);

  function newCapture(manual: boolean): LocalCapture {
    return {
      captureId: crypto.randomUUID(),
      userId: access.data!.id,
      ownerType: mode === "single" ? "hive" : "apiary",
      ownerId: mode === "single" ? hiveId : apiaryId,
      mode,
      observedAt: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      state: manual ? "review" : "captured",
      manual,
      updatedAt: new Date().toISOString(),
    };
  }
  async function chooseAudio(file: File, existing?: LocalCapture) {
    if (!canEdit || busy || !apiaryId || (mode === "single" && !hiveId)) return;
    setError("");
    try {
      const audio = prepareAudioFile(file);
      const value = existing ?? newCapture(false);
      if (value.uploadAttempted || value.mediaFileId) return;
      await persist({
        ...value,
        audio,
        audioFileName: file.name,
        state: "captured",
      });
      recorder.reset();
      setNotice(
        "Recording saved on this device. Check the observation time, then upload for review.",
      );
    } catch (err) {
      setError(message(err));
    }
  }
  async function begin(manual: boolean) {
    setError("");
    setNotice("");
    const value = newCapture(manual);
    if (manual)
      value.drafts = [
        {
          itemKey: value.captureId,
          scope: mode === "apiary" ? "apiary" : "hive",
          hiveId,
          fields: { queenSeen: null },
        },
      ];
    try {
      await persist(value);
      if (!manual) {
        recorder.reset();
        await recorder.start();
      }
    } catch (err) {
      setError(message(err));
    }
  }
  function changeDraft(draft: ReviewDraft) {
    const value = current.current;
    if (!value) return;
    void persist({
      ...value,
      drafts: value.drafts?.map((row) =>
        row.itemKey === draft.itemKey ? draft : row,
      ),
      updatedAt: new Date().toISOString(),
    }).catch((err) => setError(message(err)));
  }
  async function confirm(draft: ReviewDraft, advance: boolean) {
    const value = current.current;
    if (!value || busy || !canEdit || value.userId !== account.current) return;
    const payload = draft.pending ?? {
      ...draft.fields,
      itemKey: draft.itemKey,
      scope: draft.scope,
      hiveId: draft.scope === "hive" ? draft.hiveId : null,
      observedAt: value.observedAt,
      equipmentActions: draft.fields.equipmentActions?.filter(
        (action) => action.accepted,
      ),
    };
    if (
      payload.equipmentActions?.some(
        (action) =>
          !action.referenceId ||
          !Number.isInteger(action.quantity) ||
          action.quantity <= 0,
      )
    ) {
      setError(
        "Choose equipment and a positive whole quantity for every accepted change.",
      );
      return;
    }
    const pending = {
      ...draft,
      mutationId:
        draft.mutationId ??
        (value.manual ? value.captureId : crypto.randomUUID()),
      pending: payload,
    };
    const update = async (replacement: ReviewDraft) => {
      const latest =
        current.current?.captureId === value.captureId
          ? current.current
          : value;
      const drafts = latest.drafts?.map((row) =>
        row.itemKey === draft.itemKey ? replacement : row,
      );
      await persist({
        ...latest,
        drafts,
        state: drafts?.every((row) => row.receipt) ? "saved" : "review",
        updatedAt: new Date().toISOString(),
      });
    };
    setBusy(true);
    setError("");
    try {
      await update(pending);
      if (value.userId !== account.current) return;
      const result = value.manual
        ? await api.post<ConfirmResult>(
            "/inspection-visits",
            {
              captureId: value.captureId,
              scope: draft.scope,
              hiveId: draft.scope === "hive" ? draft.hiveId : undefined,
              apiaryId: draft.scope === "apiary" ? value.ownerId : undefined,
              observedAt: value.observedAt,
              timeZone: value.timeZone,
              inspection: payload,
            },
            { headers: { "X-Offline-Mutation-ID": value.captureId } },
          )
        : await confirmTranscription(
            value.mediaFileId!,
            value.mode,
            [payload],
            {
              versionId: value.versionId,
              mutationId: pending.mutationId,
              manualEntry: value.manualEntry,
            },
          );
      if (
        !result.success ||
        result.outcomes?.some((row) => row.status !== "saved")
      ) {
        await update({
          ...draft,
          pending: undefined,
          mutationId: undefined,
          queued: false,
        });
        throw new Error(
          (
            result.outcomes?.find((row) => row.status !== "saved") as
              | { error?: string }
              | undefined
          )?.error ??
            "This item could not be saved. Review it and retry; other saved items are unchanged.",
        );
      }
      await update({
        ...pending,
        pending: undefined,
        receipt: result,
        queued: false,
      });
      await queryClient.invalidateQueries({
        predicate: (query) =>
          !["visit-transcript", "access"].includes(String(query.queryKey[0])),
      });
      setNotice("Confirmed by the server. Your inspection is saved.");
      if (advance && nextHive) {
        selectContext("single", nextHive.id);
        display(undefined);
        recorder.reset();
      }
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        await update({ ...pending, queued: true });
        setNotice(
          "Confirmation is queued on this device. It is not yet saved on the server.",
        );
      } else {
        if (
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 409
        )
          await update({
            ...draft,
            pending: undefined,
            mutationId: undefined,
            queued: false,
          });
        setError(message(err));
        if (value.mediaFileId) void transcript.refetch();
      }
    } finally {
      setBusy(false);
    }
  }
  const active = Boolean(capture && capture.state !== "saved");
  const disabled = busy || recorder.status === "recording";
  if (capture && capture.userId !== access.data?.id)
    return <p role="status">Loading this account’s visits…</p>;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 pb-8">
      <header className="grid gap-2">
        <Link
          className="text-sm text-muted-foreground underline"
          href={apiaryId ? `/yard/apiaries/${apiaryId}` : "/yard/apiaries"}
        >
          Apiaries
          {apiaryId
            ? ` / ${ap.data?.find((row) => row.id === apiaryId)?.name ?? "Apiary"}`
            : ""}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Inspection visit
        </h1>
        <p className="text-sm text-muted-foreground">
          Speak your observations, review what was heard, and continue through
          the yard.
        </p>
      </header>
      {!online && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          Offline · recordings stay on this device until you reconnect.
        </p>
      )}
      {(error || recorder.error) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/50 p-3 text-sm text-destructive"
        >
          {error || recorder.error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {(ap.isError || hiveQuery.isError || access.isError) && (
        <p role="alert">
          Visit details could not be loaded.{" "}
          <Button
            variant="outline"
            onClick={() => {
              void ap.refetch();
              void hiveQuery.refetch();
              void access.refetch();
            }}
          >
            Retry
          </Button>
        </p>
      )}
      <section
        className="grid gap-4 rounded-xl border bg-card p-4 sm:p-6"
        aria-label="Visit context"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="grid gap-2">
            Apiary
            <select
              disabled={disabled || active || Boolean(routeApiaryId)}
              className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base"
              value={apiaryId}
              onChange={(e) => {
                setApiaryId(e.target.value);
                setHiveId("");
              }}
            >
              <option value="">Choose apiary</option>
              {ap.data?.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </Label>
          <Label className="grid gap-2">
            Record for
            <select
              disabled={disabled || active}
              className="min-h-11 min-w-0 rounded-md border bg-background px-3 text-base"
              value={mode === "single" ? hiveId : mode}
              onChange={(e) => {
                if (e.target.value === "apiary" || e.target.value === "batch")
                  selectContext(e.target.value, "");
                else selectContext("single", e.target.value);
              }}
            >
              <option value="apiary">Apiary observations</option>
              <option value="batch">Several hives in one recording</option>
              {hives.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.positionLabel}
                </option>
              ))}
            </select>
          </Label>
        </div>
        <p className="text-sm text-muted-foreground">
          {mode === "apiary"
            ? "Weather, forage, access and yard-wide notes. This creates one apiary observation."
            : mode === "batch"
              ? "Say each hive name before its observations. You will confirm each hive separately."
              : `Inspecting ${selectedHive?.positionLabel ?? "hive"}. Say what you see and any feeding or equipment changes.`}
        </p>
        {!canEdit && apiaryId && access.data && (
          <p className="text-sm">
            You have viewing access. An apiary editor can record inspections.
          </p>
        )}
        {!active && canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-12"
              disabled={disabled || !apiaryId || (mode === "single" && !hiveId)}
              onClick={() => void begin(false)}
            >
              <Mic className="size-5" />
              Record{" "}
              {mode === "single"
                ? selectedHive?.positionLabel
                : mode === "batch"
                  ? "hive walkthrough"
                  : "apiary"}
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void begin(true)}
            >
              <Keyboard className="size-4" />
              Type instead
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept={AUDIO_FILE_ACCEPT}
              className="hidden"
              aria-label="Choose recorded audio file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void chooseAudio(file);
              }}
            />
            <Button
              variant="outline"
              className="min-h-12"
              disabled={disabled || !apiaryId || (mode === "single" && !hiveId)}
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="size-4" />
              Upload recording
            </Button>
          </div>
        )}
        {recorder.status === "recording" && (
          <div className="flex flex-wrap items-center gap-4">
            <span role="status">
              Recording · {Math.floor(recorder.elapsed / 60)}:
              {String(recorder.elapsed % 60).padStart(2, "0")}
            </span>
            <Button variant="destructive" onClick={recorder.stop}>
              <Square className="size-4" />
              Stop & review
            </Button>
          </div>
        )}
        {active && recorder.status !== "recording" && capture && (
          <>
            {capture.audioFileName && (
              <p className="break-all text-sm">
                Selected recording: <strong>{capture.audioFileName}</strong>
              </p>
            )}
            <Label className="grid gap-2">
              Observed at ({capture.timeZone})
              <Input
                type="datetime-local"
                disabled={
                  busy ||
                  capture.uploadAttempted ||
                  Boolean(capture.mediaFileId) ||
                  capture.drafts?.some((row) =>
                    Boolean(row.pending || row.receipt),
                  )
                }
                value={localDate(capture.observedAt)}
                onChange={(e) => {
                  if (e.target.value)
                    void persist({
                      ...capture,
                      observedAt: new Date(e.target.value).toISOString(),
                    }).catch((err) => setError(message(err)));
                }}
              />
            </Label>
            {audioUrl && (
              <>
                <audio controls src={audioUrl} className="w-full" />
                <a
                  className="text-sm underline"
                  download={
                    capture.audioFileName ??
                    `inspection-${capture.captureId}.${capture.audio?.type.includes("mp4") ? "mp4" : "webm"}`
                  }
                  href={audioUrl}
                >
                  Download original recording
                </a>
              </>
            )}
            {capture.audio && !capture.mediaFileId && (
              <Button
                variant="outline"
                disabled={busy || !online}
                onClick={() => void upload(capture)}
              >
                <RefreshCw className="size-4" />
                {capture.audioFileName && !capture.uploadAttempted
                  ? "Upload & review"
                  : "Retry upload"}
              </Button>
            )}
            {!capture.audio && !capture.manual && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void recorder.start()}>
                  <Mic className="size-4" />
                  Start microphone
                </Button>
                <Label className="grid gap-2">
                  Or choose an audio file
                  <Input
                    type="file"
                    accept={AUDIO_FILE_ACCEPT}
                    onChange={(e) => {
                      const audio = e.target.files?.[0];
                      e.target.value = "";
                      if (audio) void chooseAudio(audio, capture);
                    }}
                  />
                </Label>
              </div>
            )}
          </>
        )}
      </section>
      {apiaryId && !active && (
        <details
          className="rounded-xl border p-3"
          open={showMap}
          onToggle={(event) => setShowMap(event.currentTarget.open)}
        >
          <summary className="min-h-11 cursor-pointer font-medium">
            Choose a hive on the apiary map
          </summary>
          {showMap && (
            <ApiaryCanvas
              apiaryId={apiaryId}
              onHiveSelect={(id) => selectContext("single", id)}
            />
          )}
        </details>
      )}
      {transcript.isError && (
        <p role="alert">
          Recording status could not be loaded.{" "}
          <Button variant="outline" onClick={() => void transcript.refetch()}>
            Retry status
          </Button>
        </p>
      )}
      {capture?.mediaFileId && !capture.drafts?.length && (
        <p role="status">
          {transcript.data?.status === "failed"
            ? (transcript.data.error ??
              "Transcription failed. Keep the recording and enter observations manually.")
            : (transcript.data?.parseError ??
              "Preparing your inspection review…")}
        </p>
      )}
      {capture?.mediaFileId &&
        !capture.drafts?.length &&
        (transcript.data?.status === "failed" ||
          transcript.data?.parseError ||
          (transcript.data?.status === "complete" &&
            !transcript.data?.parsed?.inspections.length)) && (
          <Button
            variant="outline"
            disabled={busy || !canEdit}
            onClick={() =>
              void persist({
                ...capture,
                manualEntry: true,
                state: "review",
                versionId: transcript.data?.currentVersionId ?? undefined,
                drafts: [
                  {
                    itemKey: `manual-${capture.captureId}`,
                    scope: capture.mode === "apiary" ? "apiary" : "hive",
                    hiveId,
                    fields: {
                      queenSeen: null,
                      notes: transcript.data?.transcriptionText ?? "",
                    },
                  },
                ],
              }).catch((err) => setError(message(err)))
            }
          >
            Enter observations from this recording
          </Button>
        )}
      {transcript.data?.transcriptionText && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">
            Original transcript
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-sm">
            {transcript.data.transcriptionText}
          </p>
        </details>
      )}
      {capture?.mediaFileId && (
        <Button
          variant="ghost"
          className="justify-self-start"
          disabled={busy}
          onClick={() => void transcript.refetch()}
        >
          Refresh server receipts
        </Button>
      )}
      {capture?.mediaFileId &&
        !capture.drafts?.some((row) => row.receipt || row.pending) &&
        canEdit && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={async () => {
              const replacement = {
                ...newCapture(false),
                userId: capture.userId,
                ownerType: capture.ownerType,
                ownerId: capture.ownerId,
                mode: capture.mode,
                observedAt: capture.observedAt,
                timeZone: capture.timeZone,
                replacesMediaFileId: capture.mediaFileId,
              };
              try {
                await persist(replacement);
                recorder.reset();
                await recorder.start();
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            Record a replacement — keep original
          </Button>
        )}
      {capture?.drafts?.map((draft) => (
        <VisitReview
          key={`${capture.captureId}-${draft.itemKey}`}
          draft={draft}
          hives={
            capture.mode === "single"
              ? hives.filter((row) => row.id === capture.ownerId)
              : hives
          }
          apiaryId={apiaryId}
          busy={busy || !canEdit}
          onChange={changeDraft}
          onSave={(advance) => void confirm(draft, advance)}
          nextLabel={
            capture.mode === "single" ? nextHive?.positionLabel : undefined
          }
        />
      ))}
      {capture && recorder.status !== "recording" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            display(undefined);
            recorder.reset();
            setNotice("Your capture remains in the device journal below.");
          }}
        >
          Return to recording choices
        </Button>
      )}
      {journal.length > 0 && (
        <section className="grid gap-3" aria-label="Device recording journal">
          <h2 className="text-lg font-semibold">On this device</h2>
          <p className="text-sm text-muted-foreground">
            Original audio and drafts remain available here for this account.
          </p>
          {journal
            .filter(
              (row) =>
                row.ownerId === apiaryId ||
                hives.some((hive) => hive.id === row.ownerId),
            )
            .map((row) => (
              <div
                key={row.captureId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <p className="font-medium">
                    {row.mode === "apiary"
                      ? "Apiary"
                      : row.mode === "batch"
                        ? "Hive walkthrough"
                        : (hives.find((hive) => hive.id === row.ownerId)
                            ?.positionLabel ?? "Hive")}{" "}
                    · {new Date(row.observedAt).toLocaleString()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {row.state === "saved"
                      ? "Server confirmed"
                      : row.mediaFileId
                        ? "Uploaded · review pending"
                        : row.manual
                          ? "Manual draft on device"
                          : "Audio on device · not uploaded"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    display(row);
                    setMode(row.mode);
                    setHiveId(row.ownerType === "hive" ? row.ownerId : "");
                    setError("");
                    setNotice("");
                    recorder.reset();
                    if (row.state === "recording")
                      setNotice(
                        "Interrupted recording: listen to the recovered audio before uploading; the final few seconds may be missing.",
                      );
                    else if (
                      row.audio &&
                      !row.mediaFileId &&
                      (!row.audioFileName || row.uploadAttempted)
                    )
                      void upload(row);
                  }}
                >
                  Open {row.state === "saved" ? "receipt" : "draft"}
                </Button>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
