"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { NoteText } from "@/components/record/source-note";
export function ApiaryObservations({ apiaryId }: { apiaryId: string }) {
  const records = useQuery({
    queryKey: ["apiary-inspections", apiaryId],
    queryFn: () =>
      api.get<
        {
          id: string;
          observedAt: string;
          createdAt: string;
          notes: string;
          sourceMediaFileId: string | null;
        }[]
      >("/apiary-inspections", { params: { apiaryId } }),
  });
  return (
    <div className="atlas-workspace">
      {/* Record visit is the record header's primary action; the body does not repeat it. */}
      <p className="max-w-prose text-sm text-muted-foreground">
        Apiary conditions and visit notes, kept separate from hive inspections.
      </p>
      {records.isPending ? (
        <p>Loading observations...</p>
      ) : records.isError ? (
        <p role="alert">
          Could not load observations.{" "}
          <button className="underline" onClick={() => records.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <div className="atlas-records">
          {records.data?.length ? (
            records.data.map((record) => (
              <article className="atlas-record" key={record.id} id={record.id}>
                <h2 className="font-semibold">
                  {new Date(record.observedAt).toLocaleString()}
                </h2>
                <NoteText
                  text={record.notes}
                  className="mt-2 whitespace-pre-wrap text-sm"
                  sourceClassName="mt-1"
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  Saved {new Date(record.createdAt).toLocaleString()}
                  {record.sourceMediaFileId
                    ? " / From reviewed recording"
                    : " / Manual observation"}
                </p>
              </article>
            ))
          ) : (
            <p className="atlas-record text-sm text-muted-foreground">
              No visits recorded yet. Record visit saves conditions and notes
              for the whole apiary.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
