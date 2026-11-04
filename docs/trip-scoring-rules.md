# Trip scoring rules - Sprint 1

Azure Task: AB#50 - Document trip scoring rules  
Parent story: #33 - Give a recorded trip a driving score  
Status: Draft for team review. The proposed calculation and numerical settings below are not approved client requirements.

## 1. Confirmed requirements

- Calculate the score from the recorded data for that trip.
- A calculated score must be between 0 and 100, inclusive.
- Document the rules so the same input gives the same result and tests can check it.
- Save the result against the correct trip in Supabase through the backend.
- Import and evaluate the course-provided test trip using the same scoring function as real trips. An internal script is sufficient; no import screen is required.
- A trip with insufficient data must be Unscored, with no numeric score. Zero is a valid calculated score and must not mean missing data.
- Start scoring only after the required trip samples have been stored.

These requirements come from story #33 and the supplied backend AGENTS.md.

## 2. Data needed and checks

Before implementation, confirm the existing trip/sample schema and units with the team. The supplied starter files contain health checks and a Supabase client, but no trip schema or scoring implementation.

The proposed event model needs timestamps, speed, distance, and a way to identify acceleration/braking. Speeding also requires an applicable speed limit for each evaluated interval.

- Timestamps must be valid and ordered. Confirm the duplicate/out-of-order policy before implementation; do not silently count duplicate samples twice.
- Numeric values used in the calculation must be finite. Recorded speed must not be negative.
- Convert values to agreed units before comparing thresholds. Suggested internal units: seconds, metres per second, metres per second squared, and kilometres for trip distance.
- Use a documented source for acceleration and distance. Do not assume a raw accelerometer magnitude is vehicle acceleration, or mix acceleration sources without defining their meaning.
- Missing speed limits must not be treated as evidence that no speeding occurred.
- Do not turn missing readings into zeros or invent samples to make a trip scoreable.

If the required input cannot support the agreed calculation, return Unscored with an explanatory reason. This describes scoring behavior; an invalid HTTP request should still be rejected by API validation.

## 3. Proposed calculation for discussion

The analysis report describes starting at 100 and deducting for harsh braking, harsh acceleration, and speeding, normalized by trip distance. The following makes that approach explicit for review; it does not establish approved thresholds or weights.

Let:

- B = number of harsh-braking events.
- A = number of harsh-acceleration events.
- S = number of speeding events.
- D = valid trip distance in kilometres, greater than zero and meeting the agreed minimum.
- wB, wA, wS = non-negative penalty weights selected by the team.

```text
penalty = (wB * B + wA * A + wS * S) / D
rawScore = 100 - penalty
score = round(min(100, max(0, rawScore)))
```

Proposed event counting:

- A harsh-acceleration event starts when vehicle acceleration first exceeds the agreed acceleration threshold.
- A harsh-braking event starts when vehicle acceleration first falls below the negative braking threshold.
- A speeding event starts when speed first exceeds the applicable speed limit plus an agreed tolerance.
- Consecutive qualifying intervals belong to one event. A new event can start after a non-qualifying interval. Missing data must not be treated as a normal interval that splits or validates an event.
- Agree any minimum event duration and sampling-gap policy before implementation; do not select hidden defaults.

This model can produce 100 for a sufficiently recorded trip with no detected penalty events. That is a calculated result, not a hardcoded score for every trip.

## 4. Insufficient data

At minimum, the calculation cannot run when there are no usable samples, time-based calculations have no usable positive time interval, or the proposed distance-normalized formula has no positive usable distance.

The team must also select the minimum usable sample count, recorded duration, distance, acceptable gaps, and required field coverage. A trip below any agreed minimum is Unscored. Two samples alone must not automatically qualify a trip.

Do not calculate a partial score while silently omitting a required scoring component. If speeding is retained but speed-limit data is unavailable in Sprint 1, agree a data source or explicitly revise the model before implementing it.

## 5. Worked examples and expected results

For arithmetic illustration only, use wB = 5, wA = 3, wS = 2. These example weights are not implementation defaults. Assume valid, sufficient input and event counts produced by the agreed detection rules.

| Case | Inputs | Expected result with example weights |
| --- | --- | --- |
| No penalty events | D = 10, B = 0, A = 0, S = 0 | 100 |
| Mixed events | D = 10, B = 2, A = 1, S = 1 | 100 - (10 + 3 + 2) / 10 = 98.5; rounded score 99 |
| Same events over less distance | D = 5, B = 2, A = 1, S = 1 | 97 |
| Penalty exceeds 100 | D = 1, B = 21, A = 0, S = 0 | Raw score -5; final score 0 |
| No usable samples | Empty usable sample set | Unscored; no numeric score |
| No usable distance | D = 0 | Unscored; no division by zero |
| Below agreed minimum | Valid data below an approved sufficiency threshold | Unscored; reason identifies the failed minimum |
| Missing required road limits | Speeding component required, but its input is unavailable | Unscored; no fabricated speed limits |

After thresholds are agreed, add sample-level fixtures that test exact boundary values, continuous events, separate events, missing readings, and unit conversion. Event-count examples alone do not verify event detection.

## 6. Saving and returning the result

- Scored: save the numeric score for the correct trip and return it to the client.
- Unscored: keep the numeric score absent and return the reason.
- Coordinate the exact response fields, persistence mapping, and trip state transitions with the lifecycle/frontend owners before implementation. Scoring outcomes here do not introduce new database columns or lifecycle states.
- Keep calculation in services and Supabase operations in repositories. Do not return success if persistence failed.
- Given the same samples and rules, repeated calculation must return the same score; updating the trip must not create duplicate scoring results.

## 7. Course test trip

The course test file was not included in the supplied starter files, so its format and expected result have not been checked.

Inspect its actual columns and units, map them to the agreed trip/sample structure, and pass the imported data through the same validation and scoring function. Save its result and document the run. A separately hardcoded score for that file does not meet the story.

## 8. Decisions required before this task is complete

1. Confirm the formula, event definitions, penalty weights, and rounding rule.
2. Confirm sample fields, units, acceleration/distance sources, and speed-limit availability.
3. Set data sufficiency thresholds and duplicate/gap handling.
4. Agree the result contract and persistence mapping with the relevant owners.
5. Obtain the course test file and verify its input format.

Task #50 remains in progress until the rules are agreed and documented in a reviewed/merged PR. Implementation, database changes, the importer, and automated tests belong to the separate tasks under story #33.
