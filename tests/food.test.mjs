import test from "node:test";
import assert from "node:assert/strict";
import { localDay, normalizeFoodAnalysis, totalsForDay } from "../food.js";

test("normaliza la respuesta nutricional estructurada", () => {
  const result = normalizeFoodAnalysis({
    name: "3 tercios Amstel",
    amount_description: "3 botellas de 330 ml",
    calories: 429.04,
    protein: 3,
    carbohydrates: 32.26,
    fat: 0,
    confidence: 0.93,
    meal: "snack",
    assumptions: ["Amstel Original"]
  });
  assert.equal(result.calories, 429);
  assert.equal(result.carbohydrates, 32.3);
  assert.equal(result.amountDescription, "3 botellas de 330 ml");
});

test("suma todas las comidas del mismo día", () => {
  const day = localDay("2026-07-23T12:00:00+02:00");
  const totals = totalsForDay([
    { consumedAt: "2026-07-23T12:00:00+02:00", calories: 500, protein: 40, carbohydrates: 60, fat: 12 },
    { consumedAt: "2026-07-23T20:00:00+02:00", calories: 700, protein: 55, carbohydrates: 80, fat: 20 },
    { consumedAt: "2026-07-22T20:00:00+02:00", calories: 300, protein: 20 }
  ], day);
  assert.deepEqual(totals, { calories: 1200, protein: 95, carbohydrates: 140, fat: 32 });
});

test("rechaza respuestas imposibles", () => {
  assert.throws(() => normalizeFoodAnalysis({ name: "x", calories: -1, protein: 0, carbohydrates: 0, fat: 0 }));
});
