import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveTDEE,
  averageDeficit,
  bodyComposition,
  deficitForEntry,
  projectionForTarget
} from "../stats.js";

test("calcula el déficit con energía activa y basal", () => {
  assert.equal(deficitForEntry({ calories: 1900, activeEnergy: 650, basalEnergy: 1950 }, 2400), 700);
});

test("usa el TDEE de respaldo sin datos de Salud", () => {
  assert.equal(deficitForEntry({ calories: 1900 }, 2600), 700);
});

test("calcula masa magra y peso objetivo", () => {
  const composition = bodyComposition(90, 20);
  assert.equal(composition.leanMass, 72);
  const projection = projectionForTarget({ weight: 90, bodyFat: 20, targetBodyFat: 15, dailyDeficit: 700, fromDate: new Date("2026-07-23T12:00:00Z") });
  assert.ok(Math.abs(projection.targetWeight - 84.7059) < 0.001);
  assert.equal(projection.days, 59);
  assert.equal(projection.date.toISOString().slice(0, 10), "2026-09-20");
});

test("no inventa fecha si no existe déficit", () => {
  const projection = projectionForTarget({ weight: 90, bodyFat: 20, targetBodyFat: 15, dailyDeficit: -100 });
  assert.equal(projection.status, "no-progress");
  assert.equal(projection.date, null);
});

test("marca el objetivo ya alcanzado", () => {
  const projection = projectionForTarget({ weight: 80, bodyFat: 14, targetBodyFat: 15, dailyDeficit: 500 });
  assert.equal(projection.status, "achieved");
  assert.equal(projection.days, 0);
});

test("estima TDEE adaptativo desde peso y calorías", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    calories: 2000,
    weight: 90 - index * 0.05
  }));
  const estimate = adaptiveTDEE(entries, 2500);
  assert.ok(estimate > 2350 && estimate < 2400);
});

test("promedia solo los días con datos", () => {
  const entries = [
    { date: "2026-07-20", calories: 2000 },
    { date: "2026-07-21", calories: null },
    { date: "2026-07-22", calories: 1800 }
  ];
  assert.equal(averageDeficit(entries, 2500, 7), 600);
});

