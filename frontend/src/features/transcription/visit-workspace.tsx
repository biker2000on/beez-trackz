"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Keyboard, RefreshCw, Upload } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, OfflineQueuedError } from "@/lib/api";
import { activeHives, hiveDisplayLabel } from "@/lib/hive-label";
import { cn } from "@/lib/utils";
import { useAccessProfile } from "@/features/access/api";
import {
  HiveGridPicker,
  hiveGridOrder,
} from "@/features/inspections/hive-grid-picker";
import { useAudioRecorder } from "./use-audio-recorder";
import {
  confirmTranscription,
  getTranscription,
  getHive,
  listApiaries,
  listHives,
  uploadTranscription,
  type ConfirmResult,
  type HiveSummary,
  type TranscriptionMode,
} from "./api";
import {
  captureStateFor,
  listCaptures,
  saveCapture,
  type LocalCapture,
  type ReviewDraft,
} from "./capture-store";
import { VisitReview } from "./visit-review";
import {
  isConfirmable,
  rowStatus,
  VisitLedger,
  type LedgerRun,
} from "./visit-ledger";
import { TranscriptionProgress } from "./transcription-progress";
import { AUDIO_FILE_ACCEPT, prepareAudioFile } from "./audio-upload";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Your draft is still here.";

type ConfirmOutcome = {
  outcome: "saved" | "queued" | "failed" | "stopped";
  error?: string;
};

const MODES: { value: TranscriptionMode; label: string }[] = [
  { value: "batch", label: "Whole apiary" },
  { value: "single", label: "One hive" },
  { value: "apiary", label: "Apiary only" },
];

const localDate = (date: string) => {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

/**
 * One persistent field workspace for apiary observations and hive inspections.
 *
 * - `apiaryId`: Record visit under `/yard/apiaries/[id]/visit`. It opens on
 *   the whole-apiary walkthrough (`?scope=batch` asks for it explicitly);
 *   `?scope=apiary` opens apiary notes and `?hive=` one hive.
 * - `hiveId`: Voice inspection for one hive. The hive is locked: no mode or
 *   hive choice and no "Confirm & next". The record layout owns the header.
 */
export function VisitWorkspace({
  apiaryId: routeApiaryId,
  hiveId: routeHiveId,
}: {
  apiaryId?: string;
  hiveId?: string;
}) {
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const access = useAccessProfile();
  const lockedHiveId = routeHiveId ?? "";
  const startHiveId = routeHiveId ?? search.get("hive") ?? "";
  const [chosenApiaryId, setApiaryId] = useState(
    routeApiaryId ?? search.get("apiary") ?? "",
  );
  const [hiveId, setHiveId] = useState(startHiveId);
  const [mode, setMode] = useState<TranscriptionMode>(
    startHiveId
      ? "single"
      : search.get("scope") === "apiary"
        ? "apiary"
        : search.get("scope") === "single"
          ? "single"
          : "batch",
  );
  const [capture, setCapture] = useState<LocalCapture>();
  const current = useRef<LocalCapture | undefined>(undefined);
  const [journal, setJournal] = useState<LocalCapture[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [online, setOnline] = useState(true);
  const [run, setRun] = useState<LedgerRun | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
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
    queryKey: ["hive", "visit", startHiveId],
    queryFn: () => getHive(startHiveId),
    enabled: Boolean(startHiveId && !chosenApiaryId),
  });
  const apiaryId = chosenApiaryId || initialHive.data?.apiaryId || "";
  // Every hive of this apiary, retired ones included, names a reused label;
  // only active hives can be picked, matched or recorded to.
  const apiaryHives = (hiveQuery.data ?? []).filter(
    (hive) => hive.apiaryId === apiaryId,
  );
  const hives = hiveGridOrder(activeHives(apiaryHives));
  const labelFor = (hive: HiveSummary) => hiveDisplayLabel(hive, apiaryHives);
  const canEdit = Boolean(
    access.data?.isAdmin ||
      access.data?.memberships.some(
        (m) => m.apiaryId === apiaryId && m.role === "editor",
      ),
  );
  const selectedHive = hives.find((hive) => hive.id === hiveId);
  // A hive-scoped page never moves on to another hive.
  const nextHive = lockedHiveId
    ? undefined
    : hives[hives.findIndex((hive) => hive.id === hiveId) + 1];

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
    if (lockedHiveId) return;
    setMode(selectedMode);
    setHiveId(selectedHiveId);
    const url = new URL(window.location.href);
    if (selectedMode === "single" && selectedHiveId) {
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
          if (lockedHiveId && restored.ownerId !== lockedHiveId) {
            setError(
              "This recording belongs to another hive. Open that hive to continue.",
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
    lockedHiveId,
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
        setNotice("");
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
        state: captureStateFor(drafts),
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
        "Recording saved on this device. Check the observation time, then upload it for review.",
      );
    } catch (err) {
      setError(message(err));
    }
  }
  async function begin(manual: boolean) {
    setError("");
    setNotice("");
    setRun(null);
    setRowErrors({});
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
    const drafts = value.drafts?.map((row) =>
      row.itemKey === draft.itemKey ? draft : row,
    );
    void persist({
      ...value,
      drafts,
      state: captureStateFor(drafts),
      updatedAt: new Date().toISOString(),
    }).catch((err) => setError(message(err)));
  }
  async function invalidateAfterSave() {
    await Promise.all([
      // The apiary Timeline reads this key; refresh it so the day shows now.
      queryClient.invalidateQueries({
        queryKey: ["apiaries", "detail", apiaryId, "activity"],
      }),
      queryClient.invalidateQueries({
        predicate: (query) =>
          !["visit-transcript", "access"].includes(String(query.queryKey[0])),
      }),
    ]);
  }

  /**
   * Sends one reviewed draft with its stable mutation id and records the
   * outcome in the device journal. Never throws. A lost connection returns
   * "stopped" with the draft still pending, so the retry replays the same id
   * and the server answers with the first result instead of saving twice.
   */
  async function confirmOne(draft: ReviewDraft): Promise<ConfirmOutcome> {
    const value = current.current;
    if (!value || !canEdit || value.userId !== account.current)
      return { outcome: "failed", error: "Open this visit from its own account." };
    const fail = (reason: string): ConfirmOutcome => {
      setRowErrors((rows) => ({ ...rows, [draft.itemKey]: reason }));
      return { outcome: "failed", error: reason };
    };
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
    )
      return fail(
        "Choose equipment and a whole number above zero for every equipment change you accepted.",
      );
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
        state: captureStateFor(drafts),
        updatedAt: new Date().toISOString(),
      });
    };
    try {
      // The pending payload and its mutation id are on the device before the
      // request leaves, so a reload mid-request retries the same mutation.
      await update(pending);
      if (value.userId !== account.current)
        return { outcome: "failed", error: "The signed-in account changed." };
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
        return fail(
          (
            result.outcomes?.find((row) => row.status !== "saved") as
              | { error?: string }
              | undefined
          )?.error ??
            "This entry could not be saved. Review it and try again; entries already saved are unchanged.",
        );
      }
      await update({
        ...pending,
        pending: undefined,
        receipt: result,
        queued: false,
      });
      setRowErrors((rows) => {
        if (!(draft.itemKey in rows)) return rows;
        const next = { ...rows };
        delete next[draft.itemKey];
        return next;
      });
      return { outcome: "saved" };
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        await update({ ...pending, queued: true });
        return { outcome: "queued" };
      }
      if (value.mediaFileId) void transcript.refetch();
      if (!(err instanceof ApiError))
        // No answer at all: keep the pending request so "Check again"
        // replays the same mutation id.
        return {
          outcome: "stopped",
          error:
            "Lost the connection. Your entries are kept on this device; confirm again when you're back online.",
        };
      if (err.status >= 400 && err.status < 500 && err.status !== 409)
        await update({
          ...draft,
          pending: undefined,
          mutationId: undefined,
          queued: false,
        });
      return fail(message(err));
    }
  }
  async function confirm(draft: ReviewDraft, advance: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await confirmOne(draft);
      if (result.outcome === "saved") {
        await invalidateAfterSave();
        setNotice("Saved.");
        if (advance && nextHive) {
          selectContext("single", nextHive.id);
          display(undefined);
          recorder.reset();
        }
      } else if (result.outcome === "queued") {
        setNotice("Saved on this device. It uploads when you're back online.");
      } else if (result.outcome === "stopped") {
        setError(result.error ?? "Lost the connection.");
      }
      // A failed entry shows its reason beside the entry itself.
    } finally {
      setBusy(false);
    }
  }
  async function confirmAll() {
    const value = current.current;
    if (!value?.drafts || busy || !canEdit || value.userId !== account.current)
      return;
    const targets = value.drafts.filter((draft) =>
      isConfirmable(rowStatus(draft, hives, rowErrors[draft.itemKey])),
    );
    if (targets.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    const tally: LedgerRun = {
      total: targets.length,
      done: 0,
      saved: 0,
      queued: 0,
      failed: 0,
      finished: false,
    };
    setRun({ ...tally });
    try {
      // One request at a time, in the order spoken. Each carries its own
      // mutation id; a dropped connection stops the run rather than failing
      // every remaining row.
      for (const target of targets) {
        const latest =
          current.current?.drafts?.find((row) => row.itemKey === target.itemKey) ??
          target;
        const result = await confirmOne(latest);
        tally.done += 1;
        if (result.outcome === "saved") tally.saved += 1;
        else if (result.outcome === "queued") tally.queued += 1;
        else tally.failed += 1;
        if (result.outcome === "stopped") tally.stopped = result.error;
        setRun({ ...tally });
        if (result.outcome === "stopped") break;
      }
      if (tally.saved > 0) await invalidateAfterSave();
    } finally {
      setRun({ ...tally, finished: true });
      setBusy(false);
    }
  }

  const active = Boolean(capture && capture.state !== "saved");
  const disabled = busy || recorder.status === "recording";
  const status = transcript.data?.status;
  const nothingHeard =
    status === "complete" && !transcript.data?.parsed?.inspections.length;
  const transcriptionStuck =
    status === "failed" || Boolean(transcript.data?.parseError) || nothingHeard;
  const showProgress = Boolean(
    capture &&
      !capture.drafts?.length &&
      recorder.status !== "recording" &&
      capture.state !== "recording" &&
      (capture.mediaFileId
        ? !transcriptionStuck
        : capture.audio &&
          (busy || capture.uploadAttempted || (!online && !capture.audioFileName))),
  );
  const helper =
    mode === "apiary"
      ? "Weather, forage, water and anything apiary-wide. This saves one apiary observation."
      : mode === "batch"
        ? "Walk the apiary and say each hive's label before what you see: “A1, lid popped, strong. A2, fed two gallons.” Afterward you confirm every hive in one list."
        : selectedHive
          ? `Inspecting ${labelFor(selectedHive)}. Say what you see and any feeding or equipment changes.`
          : "Choose the hive on the grid, then record or type.";

  if (capture && capture.userId !== access.data?.id)
    return <p role="status">Loading this account’s visits…</p>;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 pb-8">
      {routeApiaryId || lockedHiveId ? (
        // Under a record route the record layout owns the header.
        <p className="max-w-prose text-sm text-muted-foreground">
          Speak your observations, then confirm what was heard.
        </p>
      ) : (
        <PageHeader
          subtitle="Speak your observations, then confirm what was heard."
          actions={
            <Link
              className="inline-flex min-h-9 items-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              href={apiaryId ? `/yard/apiaries/${apiaryId}` : "/yard/apiaries"}
            >
              {apiaryId
                ? (ap.data?.find((row) => row.id === apiaryId)?.name ?? "Apiary")
                : "Apiary list"}
            </Link>
          }
        />
      )}
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
        {!routeApiaryId && !lockedHiveId && (
          <Label className="grid gap-2 sm:max-w-sm">
            Apiary
            <select
              disabled={disabled || active}
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
        )}
        {!lockedHiveId && (
          <fieldset
            className="grid min-w-0 gap-1.5"
            disabled={disabled || active}
          >
            <legend className="mb-1.5 text-sm font-medium">What to record</legend>
            <div className="grid grid-cols-3 gap-1">
              {MODES.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium transition-colors",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
                    "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
                    mode === option.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-secondary",
                  )}
                >
                  <input
                    type="radio"
                    name="visit-mode"
                    className="sr-only"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() =>
                      selectContext(
                        option.value,
                        option.value === "single" ? hiveId : "",
                      )
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {mode === "single" && !lockedHiveId && !active && apiaryId && (
          <HiveGridPicker
            hives={hives}
            selected={new Set(hiveId ? [hiveId] : [])}
            labelFor={labelFor}
            legend="Hive"
            disabled={disabled}
            emptyText={
              hiveQuery.isPending
                ? "Loading hives…"
                : "No active hives in this apiary."
            }
            onSelect={(hive) => selectContext("single", hive.id)}
          />
        )}
        <p className="text-sm text-muted-foreground">{helper}</p>
        {!canEdit && apiaryId && access.data && (
          <p className="text-sm">
            You have viewing access. An apiary editor can record inspections.
          </p>
        )}
        {!active && canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-12"
              disabled={disabled || !apiaryId || (mode === "single" && !hiveId)}
              onClick={() => void begin(false)}
            >
              <Mic className="size-5" />
              {mode === "single"
                ? `Record ${selectedHive?.positionLabel ?? "hive"}`
                : mode === "batch"
                  ? "Record walkthrough"
                  : "Record apiary"}
            </Button>
            {mode !== "batch" && (
              <Button
                variant="outline"
                className="min-h-12"
                disabled={disabled || !apiaryId || (mode === "single" && !hiveId)}
                onClick={() => void begin(true)}
              >
                <Keyboard className="size-4" />
                Type instead
              </Button>
            )}
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
            {mode === "batch" && apiaryId && (
              <Link
                href={`/yard/apiaries/${apiaryId}/bulk`}
                className="inline-flex min-h-11 items-center px-1 text-sm underline underline-offset-4"
              >
                Typing instead? Use Bulk record
              </Link>
            )}
          </div>
        )}
        {recorder.status === "recording" && (
          <div className="flex flex-wrap items-center gap-4">
            {/* The clock is not a live region: a screen reader hears
                "Recording started" and "Recording stopped" only. */}
            <span className="inline-flex items-center gap-2 font-medium tabular-nums">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full bg-destructive motion-safe:animate-pulse"
              />
              Recording {Math.floor(recorder.elapsed / 60)}:
              {String(recorder.elapsed % 60).padStart(2, "0")}
            </span>
            <Button
              variant="destructive"
              className="min-h-12"
              onClick={recorder.stop}
            >
              <Square className="size-4" />
              Stop & review
            </Button>
          </div>
        )}
        <p role="status" className="sr-only">
          {recorder.status === "recording"
            ? "Recording started"
            : recorder.status === "recorded"
              ? "Recording stopped"
              : ""}
        </p>
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
                  className="inline-flex min-h-11 items-center text-sm underline"
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
                className="min-h-12 justify-self-start"
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
                <Button
                  className="min-h-12"
                  disabled={busy}
                  onClick={() => void recorder.start()}
                >
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
      {transcript.isError && (
        <p role="alert">
          Could not check on the recording.{" "}
          <Button variant="outline" onClick={() => void transcript.refetch()}>
            Check again
          </Button>
        </p>
      )}
      {showProgress && capture && (
        <TranscriptionProgress
          hasAudio={Boolean(capture.audio || capture.mediaFileId)}
          uploading={busy}
          uploaded={Boolean(capture.mediaFileId)}
          online={online}
          transcript={transcript.data}
          since={transcript.data?.createdAt ?? capture.updatedAt}
        />
      )}
      {capture?.mediaFileId && !capture.drafts?.length && transcriptionStuck && (
        <p role="status">
          {status === "failed"
            ? (transcript.data?.error ??
              "The recording could not be turned into text. Keep it and type what you saw instead.")
            : (transcript.data?.parseError ??
              "Nothing in this recording could be sorted into hives. Type what you saw instead.")}
        </p>
      )}
      {capture?.mediaFileId && !capture.drafts?.length && transcriptionStuck && (
        <Button
          variant="outline"
          className="min-h-12 justify-self-start"
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
            What was heard
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-sm">
            {transcript.data.transcriptionText}
          </p>
        </details>
      )}
      {capture?.mediaFileId && capture.drafts?.some((row) => row.pending) && (
        <Button
          variant="outline"
          className="min-h-12 justify-self-start"
          disabled={busy}
          onClick={() => void transcript.refetch()}
        >
          Check what was saved
        </Button>
      )}
      {capture?.mediaFileId &&
        !capture.drafts?.some((row) => row.receipt || row.pending) &&
        canEdit && (
          <Button
            variant="outline"
            className="min-h-12 justify-self-start"
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
      {capture?.drafts?.length ? (
        capture.mode === "batch" ? (
          <VisitLedger
            key={capture.captureId}
            drafts={capture.drafts}
            hives={hives}
            labelFor={labelFor}
            apiaryId={apiaryId}
            observedAt={capture.observedAt}
            timeZone={capture.timeZone}
            canEdit={canEdit}
            busy={busy}
            run={run}
            rowErrors={rowErrors}
            onChange={changeDraft}
            onConfirm={(draft) => confirm(draft, false)}
            onConfirmAll={confirmAll}
          />
        ) : (
          capture.drafts.map((draft) => (
            <VisitReview
              key={`${capture.captureId}-${draft.itemKey}`}
              draft={draft}
              hives={
                capture.mode === "single"
                  ? hives.filter((row) => row.id === capture.ownerId)
                  : hives
              }
              labelFor={labelFor}
              apiaryId={apiaryId}
              busy={busy || !canEdit}
              error={rowErrors[draft.itemKey]}
              onChange={changeDraft}
              onSave={(advance) => void confirm(draft, advance)}
              nextLabel={
                capture.mode === "single" && nextHive
                  ? labelFor(nextHive)
                  : undefined
              }
            />
          ))
        )
      ) : null}
      {capture && recorder.status !== "recording" && (
        <Button
          variant="outline"
          className="min-h-12 justify-self-start"
          disabled={busy}
          onClick={() => {
            display(undefined);
            recorder.reset();
            setRun(null);
            setRowErrors({});
            setNotice(
              capture.state === "saved"
                ? ""
                : "Your recording stays in the list on this device below.",
            );
          }}
        >
          {capture.state === "saved"
            ? "Start another recording"
            : "Back to recording choices"}
        </Button>
      )}
      {journal.length > 0 && (
        <section className="grid gap-3" aria-label="Recordings on this device">
          <h2 className="text-lg font-semibold">On this device</h2>
          <p className="text-sm text-muted-foreground">
            Original audio and drafts stay here for this account until you
            clear the browser&apos;s data.
          </p>
          {journal
            .filter((row) =>
              lockedHiveId
                ? row.ownerId === lockedHiveId
                : row.ownerId === apiaryId ||
                  apiaryHives.some((hive) => hive.id === row.ownerId),
            )
            .map((row) => {
              const owner = apiaryHives.find((hive) => hive.id === row.ownerId);
              return (
                <div
                  key={row.captureId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">
                      {row.mode === "apiary"
                        ? "Apiary notes"
                        : row.mode === "batch"
                          ? "Whole-apiary walkthrough"
                          : owner
                            ? labelFor(owner)
                            : "Hive"}{" "}
                      · {new Date(row.observedAt).toLocaleString()}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {row.state === "saved"
                        ? "Saved"
                        : row.mediaFileId
                          ? "Uploaded · not confirmed yet"
                          : row.manual
                            ? "Typed draft on this device"
                            : "Recording on this device · not uploaded"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={disabled}
                    onClick={() => {
                      display(row);
                      setMode(row.mode);
                      setHiveId(row.ownerType === "hive" ? row.ownerId : "");
                      setError("");
                      setNotice("");
                      setRun(null);
                      setRowErrors({});
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
                    {row.state === "saved" ? "Open saved visit" : "Open draft"}
                  </Button>
                </div>
              );
            })}
        </section>
      )}
    </div>
  );
}
