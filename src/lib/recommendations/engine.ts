import { db } from "@/db";
import { aiRecommendations } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { recommendationRules, type RuleResult, type RecommendationType } from "./rules";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Check whether a similar undismissed recommendation already exists.
 * "Similar" = same type + same hiveId + still undismissed.
 *
 * We intentionally don't compare exact message text since the message
 * wording may change slightly between runs (e.g. "15 days" vs "16 days").
 */
async function isDuplicate(
  type: RecommendationType,
  hiveId: string
): Promise<boolean> {
  const existing = await db
    .select({ id: aiRecommendations.id })
    .from(aiRecommendations)
    .where(
      and(
        eq(aiRecommendations.type, type),
        eq(aiRecommendations.hiveId, hiveId),
        eq(aiRecommendations.dismissed, false)
      )
    )
    .limit(1);

  return existing.length > 0;
}

// ---------------------------------------------------------------------------
// AI enrichment (optional)
// ---------------------------------------------------------------------------

async function enrichMessage(
  message: string,
  type: RecommendationType
): Promise<string> {
  try {
    // Dynamic import to avoid issues when AI is not configured
    const { getAIProvider } = await import("@/lib/ai");
    const provider = await getAIProvider("recommendations");

    const prompt = `You are a helpful beekeeping assistant. Improve this recommendation message to be more actionable and helpful for a beekeeper. Keep it concise (1-2 sentences max). Do not add greetings or sign-offs.

Type: ${type}
Original: ${message}

Improved message:`;

    const enriched = await provider.chat(prompt);
    return enriched.trim() || message;
  } catch {
    // AI not configured or call failed — use original message
    return message;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface RecommendationCheckResult {
  created: number;
  skippedDuplicates: number;
  errors: string[];
}

/**
 * Run all recommendation rules, deduplicate against existing undismissed
 * recommendations, and persist new ones.
 *
 * @param options.enrichWithAI  If true, attempt to enrich messages via AI provider
 * @param options.now           Override current date (useful for testing)
 */
export async function runRecommendationCheck(
  options: { enrichWithAI?: boolean; now?: Date } = {}
): Promise<RecommendationCheckResult> {
  const now = options.now ?? new Date();
  const enrichWithAI = options.enrichWithAI ?? false;

  const result: RecommendationCheckResult = {
    created: 0,
    skippedDuplicates: 0,
    errors: [],
  };

  for (const rule of recommendationRules) {
    let ruleResults: RuleResult[];

    try {
      ruleResults = await rule.check({ now });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Rule "${rule.type}" failed: ${msg}`);
      continue;
    }

    for (const rr of ruleResults) {
      try {
        const duplicate = await isDuplicate(rule.type, rr.hiveId);
        if (duplicate) {
          result.skippedDuplicates++;
          continue;
        }

        const finalMessage = enrichWithAI
          ? await enrichMessage(rr.message, rule.type)
          : rr.message;

        await db.insert(aiRecommendations).values({
          hiveId: rr.hiveId,
          type: rule.type,
          message: finalMessage,
          priority: rr.priority,
        });

        result.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `Failed to create recommendation for hive ${rr.hiveId}: ${msg}`
        );
      }
    }
  }

  return result;
}
