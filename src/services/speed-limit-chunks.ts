import type { SpeedLimitSample } from '../types/speed-limit.js';
import { gpsDistanceKm } from './gps-distance.ts';

/** Straight-line distance is an estimate; actual matched-distance caps are checked separately. */
export function chunkSpeedLimitTrace(
    samples: readonly SpeedLimitSample[],
    options: { maxPoints: number; maxDistanceKm: number; breakDistanceKm: number },
): SpeedLimitSample[][] {
    const { maxPoints, maxDistanceKm, breakDistanceKm } = options;
    if (!Number.isInteger(maxPoints) || maxPoints < 2 ||
        !Number.isFinite(maxDistanceKm) || maxDistanceKm <= 0 ||
        !Number.isFinite(breakDistanceKm) || breakDistanceKm <= 0 || breakDistanceKm > maxDistanceKm) {
        throw new Error('Invalid trace chunk limits.');
    }
    const chunks: SpeedLimitSample[][] = [];
    let chunk: SpeedLimitSample[] = [];
    let distance = 0;
    for (const point of samples) {
        const previous = chunk.at(-1);
        const leg = previous ? gpsDistanceKm(previous, point) : 0;
        // Provider-specific gap policy is supplied by the caller.
        if (previous && leg >= breakDistanceKm) {
            chunks.push(chunk);
            chunk = [point];
            distance = 0;
        } else if (previous && (chunk.length >= maxPoints || distance + leg > maxDistanceKm)) {
            chunks.push(chunk);
            chunk = [previous, point]; // One point of context; merged by sampleId.
            distance = leg;
        } else {
            chunk.push(point);
            distance += leg;
        }
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
}
