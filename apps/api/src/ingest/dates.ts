/**
 * Calendar-day arithmetic for ingestion. Insights buckets days in the ad
 * account's own timezone, so "yesterday" is computed there — never in the
 * server's locale (docs/decisions/0005 decision 3).
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date (YYYY-MM-DD) of `instant` in an IANA timezone. */
export function dayInTimeZone(instant: Date, timeZone: string): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(instant);
}

/** Add (or subtract) whole days to a YYYY-MM-DD date string. */
export function addDays(isoDate: string, days: number): string {
	if (!ISO_DAY.test(isoDate)) {
		throw new Error(`addDays: expected YYYY-MM-DD, got ${JSON.stringify(isoDate)}`);
	}
	const date = new Date(`${isoDate}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

export interface YesterdayResult {
	date: string;
	/** The zone actually used — 'UTC' when the account's zone was unusable. */
	timezoneUsed: string;
}

/**
 * Yesterday's calendar date in the given timezone, falling back to UTC when
 * the platform reports a zone this runtime doesn't know. The fallback is
 * safe: the watermark re-pull heals a partially-fetched boundary day on the
 * next run.
 */
export function yesterdayInTimeZone(instant: Date, timeZone: string | undefined): YesterdayResult {
	if (timeZone) {
		try {
			return { date: addDays(dayInTimeZone(instant, timeZone), -1), timezoneUsed: timeZone };
		} catch {
			// fall through to UTC
		}
	}
	return { date: addDays(dayInTimeZone(instant, 'UTC'), -1), timezoneUsed: 'UTC' };
}
