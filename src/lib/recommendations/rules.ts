import { db } from "@/db";
import { hives, inspections, feedings, equipmentDeployments, equipmentStock, equipmentTypes } from "@/db/schema";
import { eq, isNull, desc, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecommendationType =
  | "inspection_due"
  | "treatment_reminder"
  | "equipment_needed"
  | "seasonal_prep"
  | "feeder_check";

export interface RuleResult {
  hiveId: string;
  message: string;
  priority: "low" | "normal" | "high" | "urgent";
}

export interface RuleContext {
  /** Current date (injectable for testing) */
  now: Date;
}

export interface RecommendationRule {
  type: RecommendationType;
  check: (context: RuleContext) => Promise<RuleResult[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Estimate treatment duration in days based on method/type string.
 * Conservative defaults so we remind rather than miss.
 */
function estimateTreatmentDurationDays(method: string): number {
  const lower = (method ?? "").toLowerCase();
  if (lower.includes("oxalic") && lower.includes("vaporiz")) return 7;
  if (lower.includes("oxalic")) return 1; // oxalic acid dribble — single application
  if (lower.includes("apivar") || lower.includes("amitraz")) return 42;
  if (lower.includes("apiguard") || lower.includes("thymol")) return 28;
  if (lower.includes("formic") || lower.includes("mite away")) return 14;
  if (lower.includes("hopguard")) return 30;
  if (lower.includes("checkmite") || lower.includes("coumaphos")) return 42;
  // Default: 14 days
  return 14;
}

// ---------------------------------------------------------------------------
// Rule: inspection_due
// ---------------------------------------------------------------------------

const inspectionDueRule: RecommendationRule = {
  type: "inspection_due",
  async check({ now }) {
    const DEFAULT_INTERVAL_DAYS = 14;
    const results: RuleResult[] = [];

    // Get all active hives
    const activeHives = await db
      .select({ id: hives.id, positionLabel: hives.positionLabel })
      .from(hives)
      .where(eq(hives.status, "active"));

    for (const hive of activeHives) {
      // Get most recent inspection for this hive
      const latest = await db
        .select({ date: inspections.date })
        .from(inspections)
        .where(eq(inspections.hiveId, hive.id))
        .orderBy(desc(inspections.date))
        .limit(1);

      const lastDate = latest[0]?.date;
      if (!lastDate) {
        // Never inspected
        results.push({
          hiveId: hive.id,
          message: `Hive "${hive.positionLabel}" has never been inspected. Schedule an inspection soon.`,
          priority: "high",
        });
        continue;
      }

      const overdueDays = daysBetween(lastDate, now) - DEFAULT_INTERVAL_DAYS;

      if (overdueDays > 14) {
        results.push({
          hiveId: hive.id,
          message: `Hive "${hive.positionLabel}" is ${overdueDays + DEFAULT_INTERVAL_DAYS} days since last inspection. Immediate inspection recommended.`,
          priority: "urgent",
        });
      } else if (overdueDays > 7) {
        results.push({
          hiveId: hive.id,
          message: `Hive "${hive.positionLabel}" is ${overdueDays + DEFAULT_INTERVAL_DAYS} days since last inspection.`,
          priority: "high",
        });
      } else if (overdueDays > 0) {
        results.push({
          hiveId: hive.id,
          message: `Hive "${hive.positionLabel}" inspection is overdue by ${overdueDays} days.`,
          priority: "normal",
        });
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// Rule: treatment_reminder
// ---------------------------------------------------------------------------

const treatmentReminderRule: RecommendationRule = {
  type: "treatment_reminder",
  async check({ now }) {
    const results: RuleResult[] = [];

    // Find inspections with treatments recorded
    const rows = await db
      .select({
        id: inspections.id,
        hiveId: inspections.hiveId,
        date: inspections.date,
        treatments: inspections.treatments,
        hiveName: hives.positionLabel,
      })
      .from(inspections)
      .innerJoin(hives, eq(inspections.hiveId, hives.id))
      .where(eq(hives.status, "active"));

    // Group by hive — only keep the latest inspection with treatments
    const hiveLatest = new Map<
      string,
      { date: Date; treatments: unknown; hiveName: string }
    >();

    for (const row of rows) {
      if (!row.treatments) continue;

      const existing = hiveLatest.get(row.hiveId);
      if (!existing || row.date > existing.date) {
        hiveLatest.set(row.hiveId, {
          date: row.date,
          treatments: row.treatments,
          hiveName: row.hiveName,
        });
      }
    }

    for (const [hiveId, data] of hiveLatest) {
      // treatments is JSONB — could be array of objects or other shapes
      const treatmentList = Array.isArray(data.treatments)
        ? data.treatments
        : [data.treatments];

      for (const t of treatmentList) {
        const method =
          typeof t === "string"
            ? t
            : typeof t === "object" && t !== null
              ? ((t as Record<string, unknown>).method as string) ??
                ((t as Record<string, unknown>).name as string) ??
                ((t as Record<string, unknown>).type as string) ??
                JSON.stringify(t)
              : String(t);

        const durationDays = estimateTreatmentDurationDays(method);
        const daysSinceTreatment = daysBetween(data.date, now);

        if (daysSinceTreatment >= durationDays) {
          const overdue = daysSinceTreatment - durationDays;
          results.push({
            hiveId,
            message: `Treatment "${method}" on hive "${data.hiveName}" may need follow-up. Applied ${daysSinceTreatment} days ago (estimated ${durationDays}-day duration).`,
            priority: overdue > 7 ? "high" : "normal",
          });
        }
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// Rule: equipment_needed
// ---------------------------------------------------------------------------

const equipmentNeededRule: RecommendationRule = {
  type: "equipment_needed",
  async check() {
    const results: RuleResult[] = [];

    // Frame shortage per hive from active deployments: box deployments
    // provide capacity (framesPerBox), frame deployments fill it.
    const deployed = await db
      .select({
        hiveId: equipmentDeployments.hiveId,
        hiveName: hives.positionLabel,
        quantity: equipmentDeployments.quantity,
        category: equipmentTypes.category,
        framesPerBox: equipmentTypes.framesPerBox,
      })
      .from(equipmentDeployments)
      .innerJoin(equipmentStock, eq(equipmentDeployments.stockId, equipmentStock.id))
      .innerJoin(equipmentTypes, eq(equipmentStock.typeId, equipmentTypes.id))
      .innerJoin(hives, eq(equipmentDeployments.hiveId, hives.id))
      .where(
        sql`${equipmentDeployments.dateRemoved} is null and ${hives.status} = 'active'`
      );

    // Aggregate per hive
    const hiveShortages = new Map<
      string,
      { hiveName: string; totalCapacity: number; totalInstalled: number }
    >();

    for (const row of deployed) {
      const entry = hiveShortages.get(row.hiveId) ?? {
        hiveName: row.hiveName,
        totalCapacity: 0,
        totalInstalled: 0,
      };
      if (row.category === "box" && row.framesPerBox) {
        entry.totalCapacity += row.quantity * row.framesPerBox;
      } else if (row.category === "frame") {
        entry.totalInstalled += row.quantity;
      }
      hiveShortages.set(row.hiveId, entry);
    }

    for (const [hiveId, data] of hiveShortages) {
      const shortage = data.totalCapacity - data.totalInstalled;
      if (shortage > 0) {
        const pct = Math.round((shortage / data.totalCapacity) * 100);
        results.push({
          hiveId,
          message: `Hive "${data.hiveName}" needs ${shortage} more frames (${pct}% capacity unfilled).`,
          priority: pct > 50 ? "high" : "normal",
        });
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// Rule: feeder_check
// ---------------------------------------------------------------------------

const feederCheckRule: RecommendationRule = {
  type: "feeder_check",
  async check({ now }) {
    const DEFAULT_CHECK_DAYS = 7;
    const results: RuleResult[] = [];

    // Active feeders: dateEmpty is null
    const activeFeedings = await db
      .select({
        id: feedings.id,
        hiveId: feedings.hiveId,
        dateFed: feedings.dateFed,
        type: feedings.type,
        hiveName: hives.positionLabel,
      })
      .from(feedings)
      .innerJoin(hives, eq(feedings.hiveId, hives.id))
      .where(isNull(feedings.dateEmpty));

    for (const f of activeFeedings) {
      const daysSinceFed = daysBetween(f.dateFed, now);
      if (daysSinceFed >= DEFAULT_CHECK_DAYS) {
        results.push({
          hiveId: f.hiveId,
          message: `Feeder on hive "${f.hiveName}" (${f.type.replace(/_/g, " ")}) placed ${daysSinceFed} days ago. Check if empty or needs refill.`,
          priority: daysSinceFed > 14 ? "high" : "normal",
        });
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// Rule: seasonal_prep
// ---------------------------------------------------------------------------

const seasonalPrepRule: RecommendationRule = {
  type: "seasonal_prep",
  async check({ now }) {
    const results: RuleResult[] = [];
    const month = now.getMonth(); // 0-indexed

    // Get all active hives for seasonal recommendations
    const activeHives = await db
      .select({ id: hives.id, positionLabel: hives.positionLabel })
      .from(hives)
      .where(eq(hives.status, "active"));

    if (activeHives.length === 0) return results;

    let seasonalMessage: string | null = null;
    let priority: RuleResult["priority"] = "normal";

    // Spring buildup: Feb (1) - Mar (2)
    if (month === 1 || month === 2) {
      seasonalMessage =
        "Spring buildup season. Check food stores, assess colony strength, and consider supplemental feeding if stores are low.";
      priority = "normal";
    }
    // Swarm season: Apr (3) - May (4)
    else if (month === 3 || month === 4) {
      seasonalMessage =
        "Swarm season alert. Inspect for swarm cells, ensure adequate space, and consider splits for strong colonies.";
      priority = "high";
    }
    // Fall prep: Sep (8) - Oct (9)
    else if (month === 8 || month === 9) {
      seasonalMessage =
        "Fall preparation time. Assess winter stores, treat for varroa if needed, and reduce entrances.";
      priority = "high";
    }
    // Winter check: Dec (11) - Jan (0)
    else if (month === 11 || month === 0) {
      seasonalMessage =
        "Winter monitoring period. Check hive weight for adequate stores, ensure ventilation, and minimize disturbance.";
      priority = "low";
    }

    if (seasonalMessage) {
      // Create one recommendation per hive
      for (const hive of activeHives) {
        results.push({
          hiveId: hive.id,
          message: `${seasonalMessage} (Hive: ${hive.positionLabel})`,
          priority,
        });
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// Export all rules
// ---------------------------------------------------------------------------

export const recommendationRules: RecommendationRule[] = [
  inspectionDueRule,
  treatmentReminderRule,
  equipmentNeededRule,
  feederCheckRule,
  seasonalPrepRule,
];

export { daysBetween, estimateTreatmentDurationDays };
