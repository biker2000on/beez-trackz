"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { apiaries, hives, inspections, equipmentTypes, equipmentStock, equipmentDeployments } from "@/db/schema";
import { parseImportFile, type ParsedImportData } from "@/lib/import/parser";
import { eq } from "drizzle-orm";
import { normalizeFormData } from "@/lib/form-values";

export async function parseImportedFile(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
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
  await requireSession();
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

        // v2 inventory: ensure the type exists, bump stock, deploy to hive
        const typeName = equipmentData.type.trim();
        let [type] = await tx
          .select()
          .from(equipmentTypes)
          .where(eq(equipmentTypes.name, typeName))
          .limit(1);
        if (!type) {
          [type] = await tx
            .insert(equipmentTypes)
            .values({
              name: typeName,
              category: "box",
              framesPerBox: equipmentData.frameCapacity ?? null,
            })
            .returning();
        }
        let [stock] = await tx
          .select()
          .from(equipmentStock)
          .where(eq(equipmentStock.typeId, type.id))
          .limit(1);
        if (!stock) {
          [stock] = await tx
            .insert(equipmentStock)
            .values({ typeId: type.id, totalOwned: 0 })
            .returning();
        }
        await tx
          .update(equipmentStock)
          .set({ totalOwned: stock.totalOwned + 1, updatedAt: new Date() })
          .where(eq(equipmentStock.id, stock.id));
        await tx.insert(equipmentDeployments).values({
          stockId: stock.id,
          hiveId,
          quantity: 1,
          dateDeployed: new Date(),
          notes: "imported",
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
