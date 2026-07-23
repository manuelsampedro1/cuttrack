import test from "node:test";
import assert from "node:assert/strict";
import { localDay, normalizeFoodAnalysis, totalsForDay, totalsForFoodItems } from "../food.js";

test("normaliza la respuesta nutricional estructurada", () => {
  const result = normalizeFoodAnalysis({
    name: "3 tercios Amstel",
    amount_description: "3 botellas de 330 ml",
    calories: 429.04,
    protein: 3,
    carbohydrates: 32.26,
    fat: 0,
    calories_low: 390,
    calories_high: 470,
    confidence: 0.93,
    meal: "snack",
    assumptions: ["Amstel Original"],
    reference_object: { detected: false, image_index: 1 },
    items: [{
      name: "Cerveza Amstel",
      estimated_weight_g: 990,
      calories: 429.04,
      calories_low: 390,
      calories_high: 470,
      protein: 3,
      carbohydrates: 32.26,
      fat: 0,
      confidence: 0.93,
      portion_basis: "3 botellas de 330 ml",
      box_2d: [],
      image_index: 1
    }]
  });
  assert.equal(result.calories, 429);
  assert.equal(result.carbohydrates, 32.3);
  assert.equal(result.amountDescription, "3 botellas de 330 ml");
  assert.equal(result.items.length, 1);
  assert.equal(result.caloriesLow, 390);
  assert.equal(result.caloriesHigh, 470);
  assert.equal(result.items[0].imageIndex, 1);
  assert.equal(result.referenceObject.imageIndex, 1);
});

test("suma componentes y conserva sus rangos", () => {
  const totals = totalsForFoodItems([
    { calories: 350, protein: 40, carbohydrates: 20, fat: 12 },
    { calories: 220, protein: 4, carbohydrates: 42, fat: 4 }
  ]);
  assert.deepEqual(totals, { calories: 570, protein: 44, carbohydrates: 62, fat: 16 });
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
