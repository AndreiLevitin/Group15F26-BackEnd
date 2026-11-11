interface Coordinates {
    latitude: number;
    longitude: number;
}

/** Great-circle distance between validated GPS coordinates, in kilometers. */
export function gpsDistanceKm(a: Coordinates, b: Coordinates): number {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const lat = radians(b.latitude - a.latitude);
    const lon = radians(b.longitude - a.longitude);
    const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.latitude)) *
        Math.cos(radians(b.latitude)) * Math.sin(lon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
