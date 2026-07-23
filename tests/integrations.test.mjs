import assert from "node:assert/strict";
import test from "node:test";

import { parseHealthExport } from "../supabase/functions/_shared/health-auto-export.ts";
import { normalizeHevyWorkouts } from "../supabase/functions/_shared/hevy.ts";

test("convierte el JSON agregado de Health Auto Export a días de CutTrack", () => {
  const payload = {
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-07-23 12:00:00 +0200", qty: 8432 }] },
        { name: "active_energy", units: "kcal", data: [{ date: "2026-07-23 12:00:00 +0200", qty: 612 }] },
        { name: "basal_energy_burned", units: "kJ", data: [{ date: "2026-07-23 12:00:00 +0200", qty: 8368 }] },
        { name: "weight_&_body_mass", units: "lb", data: [{ date: "2026-07-23 07:00:00 +0200", qty: 180 }] },
        { name: "body_fat_percentage", units: "%", data: [{ date: "2026-07-23 07:00:00 +0200", qty: 0.18 }] },
        { name: "resting_heart_rate", units: "bpm", data: [{ date: "2026-07-23 08:00:00 +0200", Avg: 53 }] },
        { name: "sleep_analysis", units: "hr", data: [{ date: "2026-07-23", totalSleep: 7.4 }] }
      ]
    }
  };
  const result = parseHealthExport(payload, "2026-07-23T12:00:00.000Z");
  assert.equal(result.healthDays.length, 1);
  assert.deepEqual(result.healthDays[0], {
    day: "2026-07-23",
    steps: 8432,
    active_energy: 612,
    basal_energy: 2000,
    weight: 81.65,
    body_fat: 18,
    resting_heart_rate: 53,
    sleep_hours: 7.4,
    health_updated_at: "2026-07-23T12:00:00.000Z",
    source: "health_auto_export"
  });
});

test("normaliza entrenamientos exportados por Salud o Garmin", () => {
  const result = parseHealthExport({ data: { workouts: [{
    id: "garmin-1",
    name: "Strength Training",
    start: "2026-07-23 18:00:00 +0200",
    end: "2026-07-23 19:05:00 +0200",
    duration: 3900
  }] } }, "2026-07-23T20:00:00.000Z");
  assert.equal(result.workouts.length, 1);
  assert.equal(result.workouts[0].source_id, "garmin-1");
  assert.equal(result.workouts[0].payload.title, "Strength Training");
  assert.equal(result.workouts[0].payload.start_time, "2026-07-23T16:00:00.000Z");
});

test("acepta respuestas envueltas o directas de Hevy", () => {
  const workout = {
    id: "hevy-1",
    title: "Upper",
    start_time: "2026-07-23T17:00:00Z",
    end_time: "2026-07-23T18:00:00Z",
    exercises: []
  };
  assert.equal(normalizeHevyWorkouts({ workouts: [workout] }).length, 1);
  assert.equal(normalizeHevyWorkouts({ data: { workouts: [workout] } })[0].source_id, "hevy-1");
  assert.equal(normalizeHevyWorkouts([workout])[0].title, "Upper");
});
