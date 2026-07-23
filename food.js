const MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);

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
  const number = (key, maximum) => {
    const parsed = Number(value[key]);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) throw new Error(`Valor inválido: ${key}`);
    return Math.round(parsed * 10) / 10;
  };
  const name = String(value.name ?? "").trim().slice(0, 180);
  if (!name) throw new Error("La IA no reconoció la comida.");
  return {
    name,
    amountDescription: String(value.amount_description ?? value.amountDescription ?? "").trim().slice(0, 500),
    calories: number("calories", 10000),
    protein: number("protein", 1000),
    carbohydrates: number("carbohydrates", 1000),
    fat: number("fat", 1000),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0.5)),
    meal: MEALS.has(value.meal) ? value.meal : "snack",
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.slice(0, 3).map(String) : []
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
