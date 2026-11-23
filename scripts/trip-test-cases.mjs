// Deterministic test inputs; expected scores are specified independently of the scorer.
// Speeds in km/h, elapsed times in seconds, posted limit 50 km/h.
const constant = (speed, count = 61) => Array(count).fill(speed);
export const tripTestCases = [
    { name:'within-tolerance', speeds:constant(55), expectedScore:100 },
    { name:'excess-10', speeds:constant(60), expectedScore:80 },
    { name:'excess-20', speeds:constant(70), expectedScore:60 },
    { name:'excess-35', speeds:constant(85), expectedScore:40 },
    { name:'excess-50', speeds:constant(100), expectedScore:0 },
    // The middle endpoint scores 80: trapezoidal weighting gives exactly 80 overall.
    { name:'mixed-100-and-60', speeds:[...constant(55,30),60,...constant(70,30)], expectedScore:80 },
    { name:'unknown-limits', speeds:constant(60), unknownLimits:true, expectedScore:null, expectedReason:'NO_EVALUATED_INTERVALS' },
    { name:'too-few-readings', speeds:constant(160,4), expectedScore:null, expectedReason:'INSUFFICIENT_READINGS' },
    { name:'below-100-metres', speeds:constant(50,6), expectedScore:null, expectedReason:'BELOW_MINIMUM_DISTANCE' },
    { name:'gps-gaps', speeds:constant(60,13), stepSeconds:5, expectedScore:null, expectedReason:'NO_EVALUATED_INTERVALS' },
];

export function generateTripPoints(scenario) {
    // A synthetic straight trace, not a claim about a real road or its posted limit.
    let metres = 0;
    const step = scenario.stepSeconds ?? 1;
    return scenario.speeds.map((speed,i) => {
        if (i > 0) metres += (scenario.speeds[i-1] + speed) / 2 / 3.6 * step;
        return { elapsedSeconds:i * step, latitude:43.46 + metres / 111195.08,
            longitude:-80.52, speed, speedLimitKmh:scenario.unknownLimits ? null : 50 };
    });
}
