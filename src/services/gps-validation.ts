export function hasValidCoordinates(point: { latitude: unknown; longitude: unknown }): point is { latitude: number; longitude: number } {
    return typeof point.latitude === 'number' && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
        typeof point.longitude === 'number' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

/** Explicit timezone, valid calendar date; shared by enrichment, distance and scoring. */
export function gpsTimestampMillis(value: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!m) return NaN;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
        Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return NaN;
    return Date.parse(value);
}
