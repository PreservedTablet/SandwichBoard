import { z } from 'zod';

/**
 * Recommendations — /analyze writes tables, not chat (docs/plan/02
 * decision 4). Rows are created by the analyst database role inside the
 * operator's Claude session (prompts/analyze.md defines the contract);
 * the API only ever changes the operator's verdict: status + outcome_note.
 */

export const recommendationKinds = [
	'scale',
	'pause',
	'new_variant',
	'budget_shift',
	'investigate'
] as const;
export type RecommendationKind = (typeof recommendationKinds)[number];

export const recommendationStatuses = ['open', 'accepted', 'rejected', 'done', 'expired'] as const;
export type RecommendationStatus = (typeof recommendationStatuses)[number];

/**
 * The operator's verdict machine: open proposals get accepted, rejected,
 * or expired; accepted work gets marked done (or expired if it never
 * happens). Nothing returns to open — the record is history.
 */
export const RECOMMENDATION_TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
	open: ['accepted', 'rejected', 'expired'],
	accepted: ['done', 'expired'],
	rejected: [],
	done: [],
	expired: []
};

const uuid = z.uuid();
const isoTimestamp = z.iso.datetime({ offset: true });

export const recommendationRowSchema = z.object({
	id: uuid,
	org_id: uuid,
	run_id: uuid,
	kind: z.enum(recommendationKinds),
	subject_creative_id: uuid.nullable(),
	rationale: z.string(),
	evidence: z.unknown(),
	status: z.enum(recommendationStatuses),
	outcome_note: z.string().nullable(),
	created_at: isoTimestamp,
	updated_at: isoTimestamp
});
export type RecommendationRow = z.infer<typeof recommendationRowSchema>;

// The API PATCH surface: verdict and note, nothing else — rationale,
// evidence, and kind are immutable (database trigger enforces it too).
export const recommendationUpdateSchema = z
	.object({
		status: z.enum(recommendationStatuses),
		outcome_note: z.string().trim().min(1).max(5000).nullable()
	})
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: 'update must change at least one field'
	});
export type RecommendationUpdate = z.infer<typeof recommendationUpdateSchema>;
