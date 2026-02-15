"use server";

import { db } from "@/db";
import { apiaries, hives, inspections, equipment } from "@/db/schema";
import { parseImportFile, type ParsedImportData } from "@/lib/import/parser";
import { eq } from "drizzle-orm";

export async function parseImportedFile(
  _prevState: unknown,
  formData: FormData
) {
  try {
    const file = formData.get("file") as File | null;

    if (!file) {
      return { error: "No file provided" };
    }

    const content = await file.text();
    const parsedData = await parseImportFile(content, file.type);

    return { success: true, data: parsedData };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to parse import file",
    };
  }
}

export async function confirmImport(data: ParsedImportData) {
  try {
    const result = await db.transaction(async (tx) => {
      const counts = {
        apiariesCreated: 0,
        hivesCreated: 0,
        inspectionsCreated: 0,
        equipmentCreated: 0,
      };

      // Create apiaries first
      const apiaryMap = new Map<string, string>();

      for (const apiaryData of data.apiaries) {
        const [created] = await tx
          .insert(apiaries)
          .values({
            name: apiaryData.name,
            notes: apiaryData.notes,
          })
          .returning();

        apiaryMap.set(apiaryData.name, created.id);
        counts.apiariesCreated++;
      }

      // Create hives and build reference map
      const hiveMap = new Map<string, string>();

      for (const hiveData of data.hives) {
        let apiaryId = apiaryMap.get(hiveData.apiaryName);

        if (!apiaryId) {
          const existing = await tx
            .select()
            .from(apiaries)
            .where(eq(apiaries.name, hiveData.apiaryName))
            .limit(1);

          if (existing.length === 0) continue;
          apiaryId = existing[0].id;
          apiaryMap.set(hiveData.apiaryName, apiaryId);
        }

        const [created] = await tx
          .insert(hives)
          .values({
            apiaryId,
            positionLabel: hiveData.positionLabel,
            status: (hiveData.status as "active" | "dead" | "sold" | "combined") || "active",
            notes: hiveData.notes,
          })
          .returning();

        const reference = `${hiveData.apiaryName} - ${hiveData.positionLabel}`;
        hiveMap.set(reference, created.id);
        counts.hivesCreated++;
      }

      // Create inspections
      for (const inspectionData of data.inspections) {
        let hiveId = hiveMap.get(inspectionData.hiveReference);

        if (!hiveId) {
          const [apiaryName, positionLabel] = inspectionData.hiveReference.split(" - ");
          if (apiaryName && positionLabel) {
            const apiaryId = apiaryMap.get(apiaryName);
            if (apiaryId) {
              const existing = await tx
                .select()
                .from(hives)
                .where(eq(hives.apiaryId, apiaryId))
                .limit(1);
              if (existing.length > 0) {
                hiveId = existing[0].id;
                hiveMap.set(inspectionData.hiveReference, hiveId);
              }
            }
          }
        }

        if (!hiveId) continue;

        await tx.insert(inspections).values({
          hiveId,
          date: new Date(inspectionData.date),
          queenSeen: inspectionData.queenSeen,
          broodPattern: inspectionData.broodPattern,
          pests: inspectionData.pests || null,
          treatments: inspectionData.treatments || null,
          notes: inspectionData.notes,
        });

        counts.inspectionsCreated++;
      }

      // Create equipment
      for (const equipmentData of data.equipment) {
        let hiveId = hiveMap.get(equipmentData.hiveReference);

        if (!hiveId) {
          const [apiaryName, positionLabel] = equipmentData.hiveReference.split(" - ");
          if (apiaryName && positionLabel) {
            const apiaryId = apiaryMap.get(apiaryName);
            if (apiaryId) {
              const existing = await tx
                .select()
                .from(hives)
                .where(eq(hives.apiaryId, apiaryId))
                .limit(1);
              if (existing.length > 0) {
                hiveId = existing[0].id;
                hiveMap.set(equipmentData.hiveReference, hiveId);
              }
            }
          }
        }

        if (!hiveId) continue;

        await tx.insert(equipment).values({
          hiveId,
          type: equipmentData.type as
            | "deep"
            | "medium"
            | "shallow"
            | "queen_excluder"
            | "double_screen"
            | "inner_cover"
            | "outer_cover"
            | "bottom_board"
            | "entrance_reducer"
            | "feeder"
            | "other",
          frameCapacity: equipmentData.frameCapacity,
        });

        counts.equipmentCreated++;
      }

      return counts;
    });

    return { success: true, result };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to import records",
    };
  }
}
