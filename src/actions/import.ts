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
    const result = {
      apiariesCreated: 0,
      hivesCreated: 0,
      inspectionsCreated: 0,
      equipmentCreated: 0,
    };

    // Create apiaries first
    const apiaryMap = new Map<string, string>(); // name -> id

    for (const apiaryData of data.apiaries) {
      const [created] = await db
        .insert(apiaries)
        .values({
          name: apiaryData.name,
          notes: apiaryData.notes,
        })
        .returning();

      apiaryMap.set(apiaryData.name, created.id);
      result.apiariesCreated++;
    }

    // Create hives and build reference map
    const hiveMap = new Map<string, string>(); // "apiaryName - positionLabel" -> hive id

    for (const hiveData of data.hives) {
      const apiaryId = apiaryMap.get(hiveData.apiaryName);

      if (!apiaryId) {
        // Try to find existing apiary
        const existing = await db
          .select()
          .from(apiaries)
          .where(eq(apiaries.name, hiveData.apiaryName))
          .limit(1);

        if (existing.length === 0) {
          continue; // Skip hive if apiary not found
        }

        apiaryMap.set(hiveData.apiaryName, existing[0].id);
      }

      const finalApiaryId = apiaryMap.get(hiveData.apiaryName);
      if (!finalApiaryId) continue;

      const [created] = await db
        .insert(hives)
        .values({
          apiaryId: finalApiaryId,
          positionLabel: hiveData.positionLabel,
          status: (hiveData.status as "active" | "dead" | "sold" | "combined") || "active",
          notes: hiveData.notes,
        })
        .returning();

      const reference = `${hiveData.apiaryName} - ${hiveData.positionLabel}`;
      hiveMap.set(reference, created.id);
      result.hivesCreated++;
    }

    // Create inspections
    for (const inspectionData of data.inspections) {
      const hiveId = hiveMap.get(inspectionData.hiveReference);

      if (!hiveId) {
        // Try to match existing hive
        const [apiaryName, positionLabel] =
          inspectionData.hiveReference.split(" - ");

        if (apiaryName && positionLabel) {
          const apiaryId = apiaryMap.get(apiaryName);
          if (apiaryId) {
            const existing = await db
              .select()
              .from(hives)
              .where(eq(hives.apiaryId, apiaryId))
              .limit(1);

            if (existing.length > 0) {
              hiveMap.set(inspectionData.hiveReference, existing[0].id);
            }
          }
        }
      }

      const finalHiveId = hiveMap.get(inspectionData.hiveReference);
      if (!finalHiveId) continue;

      await db.insert(inspections).values({
        hiveId: finalHiveId,
        date: new Date(inspectionData.date),
        queenSeen: inspectionData.queenSeen,
        broodPattern: inspectionData.broodPattern,
        pests: inspectionData.pests || null,
        treatments: inspectionData.treatments || null,
        notes: inspectionData.notes,
      });

      result.inspectionsCreated++;
    }

    // Create equipment
    for (const equipmentData of data.equipment) {
      const hiveId = hiveMap.get(equipmentData.hiveReference);

      if (!hiveId) {
        const [apiaryName, positionLabel] =
          equipmentData.hiveReference.split(" - ");

        if (apiaryName && positionLabel) {
          const apiaryId = apiaryMap.get(apiaryName);
          if (apiaryId) {
            const existing = await db
              .select()
              .from(hives)
              .where(eq(hives.apiaryId, apiaryId))
              .limit(1);

            if (existing.length > 0) {
              hiveMap.set(equipmentData.hiveReference, existing[0].id);
            }
          }
        }
      }

      const finalHiveId = hiveMap.get(equipmentData.hiveReference);
      if (!finalHiveId) continue;

      await db.insert(equipment).values({
        hiveId: finalHiveId,
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

      result.equipmentCreated++;
    }

    return { success: true, result };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to import records",
    };
  }
}
