import { readFileSync } from "node:fs";
const csvPath = process.argv[2];
if (!csvPath) {
    throw new Error('Usage: node scripts/import-course-test-trip.ts "path/to/trip.csv"');
}
function parseTime(value: string, line: number): number {
    const match =
        /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(value);

    if (!match) throw new Error(`Line ${line}: invalid timestamp`);

    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);

    const time = Date.UTC(
        year, month - 1, day, hour % 12 + (match[7] === "PM" ? 12 : 0),
        minute, second,
    );
    const date = new Date(time);

    if (
        hour < 1 || hour > 12 || minute > 59 || second > 59 ||
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        throw new Error(`Line ${line}: invalid date or time`);
    }

    return time;
}

const [header, ...lines] = readFileSync(csvPath, "utf8")
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/);

if (header !== "Timestamp,Latitude,Longitude,Speed (km/h),Speed source") {
    throw new Error("Unexpected course CSV header");
}

const readings = lines.map((line, index) => {
    const lineNumber = index + 2;
    // The timestamp is quoted because it contains a comma.
    const match = /^"([^"]+)",([^,]+),([^,]+),([^,]*),gps$/.exec(line);
    if (!match) throw new Error(`Line ${lineNumber}: invalid GPS row`);

    const [, timestamp, lat, lon, speed] = match;
    const latitude = lat?.trim() ? Number(lat) : NaN;
    const longitude = lon?.trim() ? Number(lon) : NaN;
    const speedKmh = speed?.trim() ? Number(speed) : null;

    if (
        !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
        (speedKmh !== null && (!Number.isFinite(speedKmh) || speedKmh < 0))
    ) {
        throw new Error(`Line ${lineNumber}: invalid coordinates or speed`);
    }

    return {
        time: parseTime(timestamp ?? "", lineNumber),
        latitude,
        longitude,
        speedKmh,
    };
}).sort((a, b) => a.time - b.time);

const first = readings[0];
if (!first) throw new Error("The CSV contains no GPS readings");

const radians = (degrees: number) => degrees * Math.PI / 180;
let distanceKm = 0;
let previous = first;

for (const point of readings) {
    const dLat = radians(point.latitude - previous.latitude);
    const dLon = radians(point.longitude - previous.longitude);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(radians(previous.latitude)) * Math.cos(radians(point.latitude)) *
        Math.sin(dLon / 2) ** 2;

    distanceKm += 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
    previous = point;
}

const tripId = "course-test-trip";
// The CSV has no timezone. Use a fixed test clock and preserve elapsed time.
const testStart = Date.UTC(2000, 0, 1);
const samples = readings.map(point => ({
    trip_id: tripId,
    recorded_at: new Date(testStart + (point.time - first.time)).toISOString(),
    latitude: point.latitude,
    longitude: point.longitude,
    speed_kmh: point.speedKmh,
}));

console.log(JSON.stringify({ tripId, distanceKm, samples }, null, 2));
console.error(`Imported ${samples.length} GPS readings, ${distanceKm.toFixed(3)} km.`);