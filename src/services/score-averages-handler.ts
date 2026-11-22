import type { Authenticate } from './request-auth.ts';
import type { TripAccess } from '../types/auth.js';

export const scoreAveragePeriods = [
    'day', 'week', 'month', 'year', 'last_30_days', 'all_time',
] as const;

export type ScoreAveragePeriod = typeof scoreAveragePeriods[number];

export type ScoreAverage = {
    period: ScoreAveragePeriod;
    periodStart: string;
    averageScore: number | null;
    tripCount: number;
    calculatedAt: string;
};

type FindScoreAverages = (access: TripAccess) => Promise<unknown>;

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function buildScoreAverages(value: unknown): ScoreAverage[] {
    if (!Array.isArray(value) || value.length !== scoreAveragePeriods.length) {
        throw new Error('Invalid stored score averages.');
    }

    return scoreAveragePeriods.map(period => {
        const matches = value.filter(
            row => row !== null && typeof row === 'object'
                && row.period_type === period,
        );

        if (matches.length !== 1) {
            throw new Error('Missing or duplicate average period.');
        }

        const row = matches[0] as Record<string, unknown>;
        const score = row.average_score;
        const count = row.trip_count;

        if (
            !isTimestamp(row.period_start)
            || !isTimestamp(row.calculated_at)
            || typeof count !== 'number'
            || !Number.isSafeInteger(count)
            || count < 0
            || (
                score !== null
                && (
                    typeof score !== 'number'
                    || !Number.isFinite(score)
                    || score < 0
                    || score > 100
                )
            )
            || ((count === 0) !== (score === null))
        ) {
            throw new Error('Invalid stored average values.');
        }

        return {
            period,
            periodStart: row.period_start,
            averageScore: score as number | null,
            tripCount: count,
            calculatedAt: row.calculated_at,
        };
    });
}

export function createScoreAveragesHandler(
    findAverages: FindScoreAverages,
    authenticate: Authenticate,
) {
    return async function GET(request: Request): Promise<Response> {
        const auth = await authenticate(request);
        if (!auth.ok) return auth.response;

        try {
            const stored = await findAverages(auth.access);
            return Response.json(
                {
                    timeZone: 'America/Toronto',
                    averages: buildScoreAverages(stored),
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        } catch {
            console.error('Failed to read score averages.');
            return Response.json(
                { error: 'score_averages_unavailable' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } },
            );
        }
    };
}
