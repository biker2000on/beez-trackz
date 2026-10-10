"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { Button } from "@/components/ui/button";
export function ApiaryObservations({ apiaryId }: { apiaryId: string }) {
  const access = useAccessProfile();
  const editable = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );
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
      <Link className="text-sm underline" href={`/yard/apiaries/${apiaryId}`}>
        Back to apiary
      </Link>
      <header className="atlas-heading">
        <div>
          <p className="atlas-eyebrow">Apiary / Observation history</p>
          <h1>Apiary observations</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Yard conditions and visit notes, kept separate from hive
            inspections.
          </p>
        </div>
        {editable && (
          <Button asChild>
            <Link href={`/yard/apiaries/${apiaryId}/visit`}>
              Record observation
            </Link>
          </Button>
        )}
      </header>
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
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {record.notes}
                </p>
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
              No apiary observations yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
