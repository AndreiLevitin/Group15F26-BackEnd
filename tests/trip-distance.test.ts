import assert from 'node:assert/strict';
import test from 'node:test';
import { gpsDistanceKm } from '../src/services/gps-distance.ts';
import { calculateTripDistanceKm } from '../src/services/trip-distance.ts';

test('GPS distance returns kilometers, handles identical points and crossing the dateline', () => {
    const origin = { latitude: 0, longitude: 0 };
    assert.equal(gpsDistanceKm(origin, origin), 0);
    assert.ok(Math.abs(gpsDistanceKm(origin, { latitude: 0, longitude: 1 }) - 111.194927) < 0.000001);
    assert.ok(Math.abs(gpsDistanceKm({ latitude: 0, longitude: 179.9 },
        { latitude: 0, longitude: -179.9 }) - 22.238985) < 0.000001);
});

test('trip distance preserves ordering, first duplicate timestamp, and invalid/motion filtering', () => {
    const first = { recorded_at: '2026-11-11T12:00:00Z', latitude: 0, longitude: 0 };
    const last = { recorded_at: '2026-11-11T12:01:00Z', latitude: 0, longitude: 1 };
    const distance = calculateTripDistanceKm([
        last, first, { ...first, longitude: 30 },
        { ...first, recorded_at: 'bad', longitude: 50 },
        { ...first, recorded_at: '2026-11-11T12:00:30Z', latitude: null, longitude: null },
        { ...first, recorded_at: '2026-11-11T12:00:40Z', latitude: 91 },
    ]);
    assert.ok(Math.abs(distance! - 111.194927) < 0.000001);
    assert.equal(calculateTripDistanceKm([]), null);
    assert.equal(calculateTripDistanceKm([first, { ...first, longitude: 30 }]), null);
});
