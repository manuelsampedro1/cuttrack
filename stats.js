export const KCAL_PER_KG = 7700;

export function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function safeNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date));
}

export function latestValue(entries, field, fallback = null) {
  return sortEntries(entries).reverse().find(entry => safeNumber(entry[field]) !== null)?.[field] ?? fallback;
}

export function expenditureForEntry(entry, fallbackTDEE) {
  const active = safeNumber(entry.activeEnergy);
  const basal = safeNumber(entry.basalEnergy);
  if (active !== null && basal !== null && active + basal > 0) return active + basal;
  return safeNumber(fallbackTDEE);
}

export function deficitForEntry(entry, fallbackTDEE) {
  const calories = safeNumber(entry.calories);
  const expenditure = expenditureForEntry(entry, fallbackTDEE);
  if (calories === null || expenditure === null) return null;
  return expenditure - calories;
}

export function linearSlope(points) {
  if (points.length < 2) return null;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + ((point.x - meanX) * (point.y - meanY)), 0);
  const denominator = points.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
  return denominator === 0 ? null : numerator / denominator;
}

export function adaptiveTDEE(entries, fallbackTDEE, minimumSpanDays = 7) {
  const sorted = sortEntries(entries).slice(-28);
  const weighted = sorted.filter(entry => safeNumber(entry.weight) !== null);
  const calories = sorted.filter(entry => safeNumber(entry.calories) !== null);
  if (weighted.length < 3 || calories.length < 4) return safeNumber(fallbackTDEE);

  const firstDate = new Date(`${weighted[0].date}T12:00:00`);
  const lastDate = new Date(`${weighted.at(-1).date}T12:00:00`);
  const span = (lastDate - firstDate) / 86400000;
  if (span < minimumSpanDays) return safeNumber(fallbackTDEE);

  const points = weighted.map(entry => ({
    x: (new Date(`${entry.date}T12:00:00`) - firstDate) / 86400000,
    y: Number(entry.weight)
  }));
  const slope = linearSlope(points);
  if (slope === null) return safeNumber(fallbackTDEE);
  const averageCalories = calories.reduce((sum, entry) => sum + Number(entry.calories), 0) / calories.length;
  const estimate = averageCalories - (slope * KCAL_PER_KG);
  return Math.min(5000, Math.max(1200, estimate));
}

export function recentEntries(entries, count = 7) {
  return sortEntries(entries).slice(-count);
}

export function averageDeficit(entries, fallbackTDEE, count = 7) {
  const values = recentEntries(entries, count)
    .map(entry => deficitForEntry(entry, fallbackTDEE))
    .filter(value => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function bodyComposition(weight, bodyFatPercent) {
  const currentWeight = safeNumber(weight);
  const currentBodyFat = safeNumber(bodyFatPercent);
  if (!currentWeight || !currentBodyFat || currentBodyFat <= 0 || currentBodyFat >= 100) return null;
  const leanMass = currentWeight * (1 - currentBodyFat / 100);
  return { currentWeight, currentBodyFat, leanMass };
}

export function projectionForTarget({ weight, bodyFat, targetBodyFat, dailyDeficit, fromDate = new Date() }) {
  const composition = bodyComposition(weight, bodyFat);
  const target = safeNumber(targetBodyFat);
  const rawDeficit = safeNumber(dailyDeficit);
  if (!composition || target === null || target <= 0 || target >= 100) return null;

  const targetWeight = composition.leanMass / (1 - target / 100);
  const kgRemaining = Math.max(0, composition.currentWeight - targetWeight);
  if (kgRemaining === 0) {
    return { target, targetWeight, kgRemaining, days: 0, date: new Date(fromDate), range: [0, 0], status: "achieved" };
  }
  if (rawDeficit === null || rawDeficit <= 50) {
    return { target, targetWeight, kgRemaining, days: null, date: null, range: null, status: "no-progress" };
  }

  const usableDeficit = Math.min(rawDeficit, 1500);
  const energyRemaining = kgRemaining * KCAL_PER_KG;
  const days = Math.ceil(energyRemaining / usableDeficit);
  const date = new Date(fromDate);
  date.setDate(date.getDate() + days);
  const fastDays = Math.ceil(energyRemaining / (usableDeficit * 1.2));
  const slowDays = Math.ceil(energyRemaining / (usableDeficit * 0.8));
  return { target, targetWeight, kgRemaining, days, date, range: [fastDays, slowDays], status: "projected" };
}

export function consistency(entries, settings, days = 28) {
  const recent = recentEntries(entries, days);
  if (!recent.length) return { score: 0, solidDays: 0, totalDays: 0 };
  const solidDays = recent.filter(entry => {
    const deficit = deficitForEntry(entry, settings.tdeeEstimate);
    const protein = safeNumber(entry.protein);
    return deficit !== null && deficit > 150 && protein !== null && protein >= settings.proteinTarget * 0.9;
  }).length;
  return { score: Math.round((solidDays / recent.length) * 100), solidDays, totalDays: recent.length };
}

export function movingAverage(values, windowSize = 7) {
  return values.map((value, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = values.slice(start, index + 1).filter(item => item !== null);
    return window.length ? window.reduce((sum, item) => sum + item, 0) / window.length : null;
  });
}
