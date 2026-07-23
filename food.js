const MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);

function boundedNumber(value, maximum, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) return fallback;
  return Math.round(parsed * 10) / 10;
}

function nutritionNumber(value, maximum, label) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) throw new Error(`Valor inválido: ${label}`);
  return Math.round(parsed * 10) / 10;
}

export function totalsForFoodItems(items = []) {
  return items.reduce((totals, item) => ({
    calories: totals.calories + boundedNumber(item.calories, 10000),
    protein: totals.protein + boundedNumber(item.protein, 1000),
    carbohydrates: totals.carbohydrates + boundedNumber(item.carbohydrates, 1000),
    fat: totals.fat + boundedNumber(item.fat, 1000)
  }), { calories: 0, protein: 0, carbohydrates: 0, fat: 0 });
}

function normalizeBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return [];
  const box = value.map(number => Math.round(Number(number)));
  if (box.some(number => !Number.isFinite(number) || number < 0 || number > 1000)) return [];
  if (box[2] <= box[0] || box[3] <= box[1]) return [];
  return box;
}

export function normalizeFoodItem(value, index = 0) {
  const name = String(value?.name ?? "").trim().slice(0, 120);
  if (!name) throw new Error(`Falta el nombre del alimento ${index + 1}.`);
  const calories = nutritionNumber(value.calories, 10000, "calories");
  return {
    id: String(value.id ?? `item-${index + 1}`).slice(0, 80),
    name,
    estimatedWeightG: nutritionNumber(value.estimated_weight_g ?? value.estimatedWeightG, 5000, "estimated_weight_g"),
    calories,
    caloriesLow: Math.min(calories, boundedNumber(value.calories_low ?? value.caloriesLow, 10000, calories)),
    caloriesHigh: Math.max(calories, boundedNumber(value.calories_high ?? value.caloriesHigh, 10000, calories)),
    protein: nutritionNumber(value.protein, 1000, "protein"),
    carbohydrates: nutritionNumber(value.carbohydrates, 1000, "carbohydrates"),
    fat: nutritionNumber(value.fat, 1000, "fat"),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0.5)),
    portionBasis: String(value.portion_basis ?? value.portionBasis ?? "Estimación visual").trim().slice(0, 180),
    box2d: normalizeBox(value.box_2d ?? value.box2d)
  };
}

export function localDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function normalizeFoodAnalysis(value) {
  if (!value || typeof value !== "object") throw new Error("La IA no devolvió una comida válida.");
  const name = String(value.name ?? "").trim().slice(0, 180);
  if (!name) throw new Error("La IA no reconoció la comida.");
  const items = Array.isArray(value.items)
    ? value.items.slice(0, 30).map(normalizeFoodItem)
    : [];
  if (!items.length) {
    items.push(normalizeFoodItem({
      name,
      estimated_weight_g: 0,
      calories: value.calories,
      calories_low: value.calories_low ?? value.calories,
      calories_high: value.calories_high ?? value.calories,
      protein: value.protein,
      carbohydrates: value.carbohydrates,
      fat: value.fat,
      confidence: value.confidence,
      portion_basis: value.amount_description ?? value.amountDescription
    }));
  }
  const totals = totalsForFoodItems(items);
  const itemCaloriesLow = Math.round(items.reduce((total, item) => total + item.caloriesLow, 0) * 10) / 10;
  const itemCaloriesHigh = Math.round(items.reduce((total, item) => total + item.caloriesHigh, 0) * 10) / 10;
  const caloriesLow = boundedNumber(value.calories_low ?? value.caloriesLow, 10000, itemCaloriesLow);
  const caloriesHigh = boundedNumber(value.calories_high ?? value.caloriesHigh, 10000, itemCaloriesHigh);
  const referenceValue = value.reference_object ?? value.referenceObject ?? {};
  return {
    name,
    amountDescription: String(value.amount_description ?? value.amountDescription ?? "").trim().slice(0, 500),
    ...totals,
    caloriesLow: Math.min(caloriesLow, totals.calories),
    caloriesHigh,
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0.5)),
    meal: MEALS.has(value.meal) ? value.meal : "snack",
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.slice(0, 5).map(String) : [],
    items,
    referenceObject: {
      detected: Boolean(referenceValue.detected),
      object: String(referenceValue.object ?? "").trim().slice(0, 120),
      assumedWidthMm: boundedNumber(referenceValue.assumed_width_mm ?? referenceValue.assumedWidthMm, 1000),
      assumedHeightMm: boundedNumber(referenceValue.assumed_height_mm ?? referenceValue.assumedHeightMm, 1000),
      confidence: Math.max(0, Math.min(1, Number(referenceValue.confidence) || 0)),
      samePlane: Boolean(referenceValue.same_plane ?? referenceValue.samePlane)
    }
  };
}

export function totalsForDay(foods, day) {
  return foods
    .filter(food => !food.deletedAt && localDay(food.consumedAt) === day)
    .reduce((totals, food) => ({
      calories: totals.calories + Number(food.calories || 0),
      protein: totals.protein + Number(food.protein || 0),
      carbohydrates: totals.carbohydrates + Number(food.carbohydrates || 0),
      fat: totals.fat + Number(food.fat || 0)
    }), { calories: 0, protein: 0, carbohydrates: 0, fat: 0 });
}

export function mealLabel(value) {
  return ({ breakfast: "Desayuno", lunch: "Comida", dinner: "Cena", snack: "Snack" })[value] ?? "Snack";
}
