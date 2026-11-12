import { gpsTimestampMillis, hasValidCoordinates } from './gps-validation.ts';
import { createTripScoringConfig, type TripScoringConfig } from '../config/trip-scoring-config.ts';
export const SCORING_VERSION = 'road-bands-v2';
export interface RecordedTripSample {
    sample_id: string;
    trip_id: string;
    recorded_at: string;
    latitude: number | null;
    longitude: number | null;
    speed_kmh: number | null;
    road_speed_limit_kmh: number | null;
}
export interface SampleScoringDecision {
    sampleId: string;
    status: 'used' | 'duplicate' | 'ignored' | 'unscored' | 'excluded';
    speedLimitKmhUsed: number | null;
    toleranceKmhUsed: number | null;
    thresholdKmh: number | null;
    usedFallback: boolean | null;
    isSpeeding: boolean | null;
    startsEvent: boolean | null;
    readingScore: number | null;
}
export type IntervalExclusion = 'gps_gap' | 'invalid_endpoint' | 'stationary' | 'unknown_limit';
export interface IntervalScoringDecision {
    startSampleId: string;
    endSampleId: string;
    durationSeconds: number;
    score: number | null;
    exclusionReason: IntervalExclusion | null;
}
export interface ScoringQuality {
    evaluatedReadings: number;
    evaluatedSeconds: number;
    validMovingSeconds: number;
    coveragePercent: number | null;
    unknownLimitSeconds: number;
    stationarySeconds: number;
    gpsGapSeconds: number;
    invalidEndpointSeconds: number;
    weightedScore: number;
    timeByScore: { score: number; seconds: number }[];
}
export interface TripScoringInput {
    tripId: string;
    distanceKm: number | null;
    samples: readonly RecordedTripSample[];
}
export type UnscoredReason = 'NO_GPS_READINGS' | 'TRIP_ID_MISMATCH' | 'INSUFFICIENT_READINGS' |
    'MISSING_OR_INVALID_DISTANCE' | 'BELOW_MINIMUM_DISTANCE' | 'NO_EVALUATED_INTERVALS';
interface Audit {
    scoringVersion: typeof SCORING_VERSION;
    validReadings: number;
    ignoredReadings: number;
    duplicateTimestampReadings: number;
    sampleDecisions: SampleScoringDecision[];
    intervalDecisions: IntervalScoringDecision[];
    quality: ScoringQuality;
}
export type TripScoringResult = Audit & (
    { scoringStatus: 'Scored'; score: number; speedingEvents: number; distanceKm: number } |
    { scoringStatus: 'Unscored'; score: null; reason: UnscoredReason }
);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** No intermediate readings are invented. Only short, adjacent GPS pairs contribute. */
export function calculateTripScore(input: TripScoringInput, parameters: TripScoringConfig): TripScoringResult {
    const config = createTripScoringConfig(parameters);
    const audit: Audit = {
        scoringVersion: SCORING_VERSION, validReadings: 0, ignoredReadings: 0, duplicateTimestampReadings: 0,
        sampleDecisions: input.samples.map(s => ({ sampleId: s.sample_id, status: 'ignored',
            speedLimitKmhUsed: null, toleranceKmhUsed: null, thresholdKmh: null, usedFallback: null,
            isSpeeding: null, startsEvent: null, readingScore: null })), intervalDecisions: [],
        quality: { evaluatedReadings: 0, evaluatedSeconds: 0, validMovingSeconds: 0, coveragePercent: null,
            unknownLimitSeconds: 0, stationarySeconds: 0, gpsGapSeconds: 0, invalidEndpointSeconds: 0,
            weightedScore: 0, timeByScore: [] },
    };
    const unscored = (reason: UnscoredReason): TripScoringResult => {
        // An interval can be eligible without the whole trip meeting minimum requirements.
        for (const d of audit.sampleDecisions) if (d.status === 'used') {
            d.status = 'unscored'; d.speedLimitKmhUsed = null; d.toleranceKmhUsed = null;
            d.thresholdKmh = null; d.usedFallback = null; d.isSpeeding = null; d.startsEvent = null;
        }
        return { ...audit, scoringStatus: 'Unscored', score: null, reason };
    };
    if (!input.tripId || input.samples.some(s => s.trip_id !== input.tripId)) return unscored('TRIP_ID_MISMATCH');
    if (new Set(input.samples.map(s => s.sample_id)).size !== input.samples.length || input.samples.some(s => !s.sample_id)) {
        throw new Error('Scoring samples must have unique stable IDs.');
    }
    const byTime = new Map<number, number>();
    // Keep invalid timestamped GPS rows as barriers, so filtering cannot bridge a bad reading.
    const invalid: { time: number; index: number }[] = [];
    for (const [index, s] of input.samples.entries()) {
        const time = gpsTimestampMillis(s.recorded_at);
        if (!Number.isFinite(time) || !hasValidCoordinates(s) || !finite(s.speed_kmh) || s.speed_kmh < 0) {
            audit.ignoredReadings++;
            if (Number.isFinite(time)) invalid.push({ time, index });
            continue;
        }
        if (s.road_speed_limit_kmh !== null && (!finite(s.road_speed_limit_kmh) || s.road_speed_limit_kmh <= 0 ||
            !Number.isFinite(s.road_speed_limit_kmh + config.toleranceKmh))) throw new Error('Invalid stored road speed limit.');
        const previous = byTime.get(time);
        if (previous !== undefined) {
            audit.duplicateTimestampReadings++;
            const prev = input.samples[previous]!;
            if (s.speed_kmh < prev.speed_kmh! || (s.speed_kmh === prev.speed_kmh && s.sample_id >= prev.sample_id)) {
                audit.sampleDecisions[index]!.status = 'duplicate'; continue;
            }
            audit.sampleDecisions[previous]!.status = 'duplicate';
        }
        audit.sampleDecisions[index]!.status = 'excluded';
        byTime.set(time, index);
    }
    audit.validReadings = byTime.size;
    const readings = [...byTime.entries()].map(([time, index]) => ({ time, index }));
    // A valid reading at exactly the same timestamp supersedes an invalid one.
    readings.push(...invalid.filter(r => !byTime.has(r.time)));
    readings.sort((a, b) => a.time - b.time || input.samples[a.index]!.sample_id.localeCompare(input.samples[b.index]!.sample_id));
    for (const { index } of readings) {
        const d = audit.sampleDecisions[index]!, s = input.samples[index]!;
        if (d.status === 'ignored' || s.road_speed_limit_kmh === null) continue;
        const excess = s.speed_kmh! - s.road_speed_limit_kmh;
        let score = 100;
        if (excess > config.toleranceKmh) {
            score = config.bands[0]!.score;
            for (const band of config.bands) if (excess >= band.fromKmh) score = band.score;
        }
        d.readingScore = score;
    }
    const participating = new Set<number>();
    const eligibleEnds = new Set<string>();
    const categoryTime = new Map<number, number>();
    const q = audit.quality;
    for (let i = 1; i < readings.length; i++) {
        const a = readings[i - 1]!, b = readings[i]!;
        const duration = (b.time - a.time) / 1000;
        if (duration <= 0) continue;
        const da = audit.sampleDecisions[a.index]!, db = audit.sampleDecisions[b.index]!;
        const sa = input.samples[a.index]!, sb = input.samples[b.index]!;
        let reason: IntervalExclusion | null = null;
        if (duration > config.maxIntervalSeconds) { reason = 'gps_gap'; q.gpsGapSeconds += duration; }
        else if (da.status === 'ignored' || db.status === 'ignored') { reason = 'invalid_endpoint'; q.invalidEndpointSeconds += duration; }
        else if ((sa.speed_kmh! + sb.speed_kmh!) / 2 < config.minMovingSpeedKmh) { reason = 'stationary'; q.stationarySeconds += duration; }
        else {
            q.validMovingSeconds += duration;
            if (da.readingScore === null || db.readingScore === null) { reason = 'unknown_limit'; q.unknownLimitSeconds += duration; }
        }
        const score = reason === null ? (da.readingScore! + db.readingScore!) / 2 : null;
        audit.intervalDecisions.push({ startSampleId: sa.sample_id, endSampleId: sb.sample_id,
            durationSeconds: duration, score, exclusionReason: reason });
        if (score === null) continue;
        participating.add(a.index); participating.add(b.index); eligibleEnds.add(sb.sample_id);
        q.evaluatedSeconds += duration; q.weightedScore += duration * score;
        for (const d of [da, db]) categoryTime.set(d.readingScore!, (categoryTime.get(d.readingScore!) ?? 0) + duration / 2);
    }
    q.evaluatedReadings = participating.size;
    q.coveragePercent = q.validMovingSeconds > 0 ? 100 * q.evaluatedSeconds / q.validMovingSeconds : null;
    q.timeByScore = [...categoryTime.entries()].sort(([a], [b]) => b - a).map(([score, seconds]) => ({ score, seconds }));
    let speedingEvents = 0;
    let previousUsedTime: number | null = null;
    let wasSpeeding = false;
    for (const { time, index } of readings) {
        if (!participating.has(index)) { previousUsedTime = null; wasSpeeding = false; continue; }
        const s = input.samples[index]!, d = audit.sampleDecisions[index]!;
        const threshold = s.road_speed_limit_kmh! + config.toleranceKmh;
        const speeding = s.speed_kmh! > threshold;
        // Rejected intervals break event continuity, even when both endpoints participate elsewhere.
        const connected = previousUsedTime !== null && eligibleEnds.has(s.sample_id);
        const starts = speeding && !(connected && wasSpeeding);
        if (starts) speedingEvents++;
        Object.assign(d, { status: 'used', speedLimitKmhUsed: s.road_speed_limit_kmh,
            toleranceKmhUsed: config.toleranceKmh, thresholdKmh: threshold,
            usedFallback: false, isSpeeding: speeding, startsEvent: starts });
        previousUsedTime = time; wasSpeeding = speeding;
    }
    if (audit.validReadings < config.minValidReadings) return unscored('INSUFFICIENT_READINGS');
    if (!finite(input.distanceKm) || input.distanceKm <= 0) return unscored('MISSING_OR_INVALID_DISTANCE');
    if (input.distanceKm < config.minDistanceKm) return unscored('BELOW_MINIMUM_DISTANCE');
    if (q.evaluatedSeconds === 0) return unscored('NO_EVALUATED_INTERVALS');
    if (q.evaluatedReadings < config.minValidReadings) return unscored('INSUFFICIENT_READINGS');
    const exact = q.weightedScore / q.evaluatedSeconds;
    // Reserve displayed zero for entirely zero-rated evaluated driving.
    const score = exact === 0 ? 0 : Math.min(100, Math.max(1, Math.round(exact)));
    return { ...audit, scoringStatus: 'Scored', score, speedingEvents, distanceKm: input.distanceKm };
}
