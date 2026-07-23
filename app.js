import {
  KCAL_PER_KG,
  adaptiveTDEE,
  averageDeficit,
  consistency,
  deficitForEntry,
  latestValue,
  movingAverage,
  projectionForTarget,
  recentEntries,
  round,
  safeNumber,
  sortEntries
} from "./stats.js";
import { cloud } from "./cloud.js";
import { localDay, mealLabel, normalizeFoodAnalysis, totalsForDay } from "./food.js";

const LEGACY_STORAGE_KEY = "cuttrack.v1";
const STORAGE_KEY = "cuttrack.cache.v1";
const HEALTH_EXPORT_TOKEN_KEY = "cuttrack.health-export.v1";
const defaultState = {
  version: 1,
  configured: false,
  settings: {
    calorieTarget: 1900,
    proteinTarget: 180,
    tdeeEstimate: 2600,
    mainBodyFatTarget: 15,
    currentWeight: null,
    currentBodyFat: null
  },
  entries: [],
  foods: [],
  workouts: []
};

let state = loadState();
let deferredInstallPrompt = null;
let cloudSyncPromise = null;
let selectedFoodImage = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const formatNumber = (value, digits = 0) => Number(value).toLocaleString("es-ES", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const formatDate = date => new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(date);
const todayISO = () => localDay();

function storageKey() {
  return cloud.user?.id ? `${STORAGE_KEY}.${cloud.user.id}` : null;
}

function healthExportTokenKey() {
  return `${HEALTH_EXPORT_TOKEN_KEY}.${cloud.user?.id ?? "signed-out"}`;
}

function parseState(raw) {
  try {
    const stored = JSON.parse(raw);
    if (!stored || stored.version !== 1) return structuredClone(defaultState);
    return {
      ...structuredClone(defaultState),
      ...stored,
      settings: { ...defaultState.settings, ...stored.settings },
      entries: Array.isArray(stored.entries) ? stored.entries : [],
      foods: Array.isArray(stored.foods) ? stored.foods : [],
      workouts: Array.isArray(stored.workouts) ? stored.workouts : []
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function loadState() {
  const key = storageKey();
  if (!key) return structuredClone(defaultState);
  const scoped = localStorage.getItem(key);
  if (scoped) return parseState(scoped);
  return parseState(localStorage.getItem(LEGACY_STORAGE_KEY));
}

function saveState() {
  const key = storageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(state));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function currentModel() {
  const tdee = adaptiveTDEE(state.entries, state.settings.tdeeEstimate);
  const entries = sortEntries(state.entries);
  const latest = entries.at(-1) ?? null;
  const weight = safeNumber(latestValue(entries, "weight", state.settings.currentWeight));
  const bodyFat = safeNumber(latestValue(entries, "bodyFat", state.settings.currentBodyFat));
  const dailyDeficit = latest ? deficitForEntry(latest, tdee) : null;
  const weeklyDeficit = averageDeficit(entries, tdee, 7);
  return { tdee, entries, latest, weight, bodyFat, dailyDeficit, weeklyDeficit };
}

function metricCard(icon, value, label, tone = "blue") {
  return `<article class="metric-card card"><span class="metric-icon ${tone}">${icon}</span><strong>${value}</strong><small>${label}</small></article>`;
}

function renderToday() {
  const model = currentModel();
  const latest = model.latest;
  const deficit = model.dailyDeficit;
  const calorieValue = safeNumber(latest?.calories);
  const proteinValue = safeNumber(latest?.protein);

  $("#header-goal").textContent = `${formatNumber(state.settings.mainBodyFatTarget, 0)}%`;
  $("#header-subtitle").textContent = `${formatNumber(state.settings.calorieTarget)} kcal · ${formatNumber(state.settings.proteinTarget)} g proteína`;
  $("#today-label").textContent = latest ? new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "short" }).format(new Date(`${latest.date}T12:00:00`)).toUpperCase() : "HOY";
  $("#today-deficit").textContent = deficit === null ? "···" : `${deficit >= 0 ? "−" : "+"}${formatNumber(Math.abs(deficit))}`;
  $("#today-deficit").className = deficit !== null && deficit < 0 ? "surplus" : "";
  $("#today-deficit-copy").textContent = deficit === null
    ? "Registra calorías y gasto para calcular tu déficit."
    : deficit >= 0
      ? `Has gastado unas ${formatNumber(deficit)} kcal más de las ingeridas.`
      : `Hoy llevas un superávit estimado de ${formatNumber(Math.abs(deficit))} kcal.`;

  const targetDeficit = Math.max(100, model.tdee - state.settings.calorieTarget);
  const percent = deficit === null ? 0 : Math.max(0, Math.min(140, (deficit / targetDeficit) * 100));
  $("#deficit-ring").style.setProperty("--progress", `${Math.min(100, percent) * 3.6}deg`);
  $("#ring-percent").textContent = `${Math.round(percent)}%`;

  const stepValue = safeNumber(latest?.steps);
  const sleepValue = safeNumber(latest?.sleep);
  $("#today-metrics").innerHTML = [
    metricCard("◔", calorieValue === null ? "Sin dato" : formatNumber(calorieValue), `kcal · objetivo ${formatNumber(state.settings.calorieTarget)}`, calorieValue !== null && calorieValue <= state.settings.calorieTarget ? "green" : "coral"),
    metricCard("P", proteinValue === null ? "Sin dato" : `${formatNumber(proteinValue)} g`, `proteína · objetivo ${formatNumber(state.settings.proteinTarget)} g`, proteinValue !== null && proteinValue >= state.settings.proteinTarget ? "green" : "blue"),
    metricCard("↟", stepValue === null ? "Sin dato" : formatNumber(stepValue), "pasos", "blue"),
    metricCard("☾", sleepValue === null ? "Sin dato" : `${formatNumber(sleepValue, 1)} h`, "sueño", "purple")
  ].join("");

  renderProjections(model);
  renderWeekly(model);
  renderInsight(model);
  renderFoods();
}

function foodRow(food, { includeDate = false } = {}) {
  const consumed = new Date(food.consumedAt);
  const date = includeDate
    ? new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short" }).format(consumed)
    : mealLabel(food.meal);
  const confidence = food.confidence !== null && Number(food.confidence) < 0.65
    ? `<span class="food-confidence">revisar</span>`
    : "";
  return `<button class="food-row card" type="button" data-food-id="${escapeHTML(food.id)}">
    <span class="food-row-icon">${food.source === "photo_ai" ? "◎" : "✦"}</span>
    <span class="food-row-copy">
      <span class="food-row-meta">${escapeHTML(date)} ${confidence}</span>
      <strong>${escapeHTML(food.name)}</strong>
      <small>${escapeHTML(food.amountDescription || "Estimación de la IA")}</small>
      <span class="food-macros">P ${formatNumber(food.protein, 0)} · C ${formatNumber(food.carbohydrates, 0)} · G ${formatNumber(food.fat, 0)}</span>
    </span>
    <span class="food-row-calories"><strong>${formatNumber(food.calories)}</strong><small>kcal</small></span>
  </button>`;
}

function renderFoods() {
  const foods = [...state.foods].filter(food => !food.deletedAt).sort((a, b) => String(b.consumedAt).localeCompare(String(a.consumedAt)));
  const today = todayISO();
  const todayFoods = foods.filter(food => localDay(food.consumedAt) === today);
  const totals = totalsForDay(todayFoods, today);
  $("#today-food-total").textContent = `${formatNumber(totals.calories)} kcal`;
  $("#today-food-list").innerHTML = todayFoods.length
    ? todayFoods.map(food => foodRow(food)).join("")
    : `<button class="empty-food card" id="empty-food-add" type="button"><span>✦</span><strong>Añade la primera comida</strong><small>Haz una foto o escríbela tal cual</small></button>`;
  $("#all-food-list").innerHTML = foods.length
    ? foods.slice(0, 60).map(food => foodRow(food, { includeDate: true })).join("")
    : `<p class="empty-state">Todavía no hay comidas. La primera se añadirá aquí automáticamente.</p>`;
}

function projectionDate(projection) {
  if (!projection) return "Completa peso y grasa";
  if (projection.status === "achieved") return "Objetivo alcanzado";
  if (projection.status === "no-progress") return "Sin fecha a este ritmo";
  return formatDate(projection.date);
}

function projectionDetail(projection) {
  if (!projection?.days || !projection.range) return "";
  return `${projection.days} días · rango ${projection.range[0]} a ${projection.range[1]}`;
}

function renderProjections(model) {
  const targets = [...new Set([18, state.settings.mainBodyFatTarget, 13])].sort((a, b) => b - a);
  $("#projection-list").innerHTML = targets.map(target => {
    const daily = projectionForTarget({ weight: model.weight, bodyFat: model.bodyFat, targetBodyFat: target, dailyDeficit: model.dailyDeficit });
    const weekly = projectionForTarget({ weight: model.weight, bodyFat: model.bodyFat, targetBodyFat: target, dailyDeficit: model.weeklyDeficit });
    const kilos = daily?.kgRemaining ?? weekly?.kgRemaining;
    return `<article class="projection-card card">
      <div class="target-badge">${formatNumber(target, 0)}%</div>
      <div class="projection-copy">
        <div><small>COMO HOY</small><strong>${projectionDate(daily)}</strong>${daily?.days ? `<span>${projectionDetail(daily)}</span>` : ""}</div>
        <div><small>PROMEDIO 7 DÍAS</small><strong>${projectionDate(weekly)}</strong>${weekly?.days ? `<span>${projectionDetail(weekly)}</span>` : ""}</div>
      </div>
      <div class="projection-meta">${kilos === undefined ? "Añade tu punto de partida" : `${formatNumber(kilos, 1)} kg estimados por perder`}</div>
    </article>`;
  }).join("");
}

function renderWeekly(model) {
  const entries = recentEntries(model.entries, 7);
  const days = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const iso = date.toISOString().slice(0, 10);
    const entry = entries.find(item => item.date === iso);
    days.push({ date, value: entry ? deficitForEntry(entry, model.tdee) : null });
  }
  const max = Math.max(800, ...days.map(day => Math.abs(day.value ?? 0)));
  $("#deficit-chart").innerHTML = days.map(day => {
    const height = day.value === null ? 4 : Math.max(8, Math.min(100, (Math.abs(day.value) / max) * 100));
    const className = day.value === null ? "missing" : day.value >= 0 ? "deficit" : "surplus";
    const label = new Intl.DateTimeFormat("es-ES", { weekday: "narrow" }).format(day.date);
    return `<div class="bar-column"><strong>${day.value === null ? "·" : formatNumber(day.value)}</strong><div class="bar-track"><i class="${className}" style="height:${height}%"></i></div><small>${label}</small></div>`;
  }).join("");
  const average = model.weeklyDeficit;
  const available = days.filter(day => day.value !== null);
  const total = available.reduce((sum, day) => sum + day.value, 0);
  $("#weekly-deficit").textContent = average === null ? "Sin datos" : `${formatNumber(average)} kcal/día`;
  $("#weekly-balance").textContent = `${formatNumber(total)} kcal acumuladas`;
  $("#weekly-equivalent").textContent = `≈ ${formatNumber(total / KCAL_PER_KG, 2)} kg teóricos`;
}

function renderInsight(model) {
  let title = "Empieza registrando hoy";
  let copy = "Con siete días podremos comparar tu ritmo real con el previsto.";
  if (model.weeklyDeficit !== null) {
    if (model.weeklyDeficit > 1000) {
      title = "El ritmo semanal es muy agresivo";
      copy = "Revisa que energía activa, basal y calorías estén bien introducidas. Las proyecciones limitan déficits extremos para no darte una fecha engañosa.";
    } else if (model.weeklyDeficit >= 350) {
      title = "La semana apunta en la dirección correcta";
      copy = `Promedias ${formatNumber(model.weeklyDeficit)} kcal de déficit. Mira también proteína, rendimiento y la tendencia de peso antes de tocar el objetivo.`;
    } else if (model.weeklyDeficit > 50) {
      title = "Déficit pequeño, progreso más lento";
      copy = "No es necesariamente malo. La tendencia de varias semanas dirá si hace falta ajustar algo.";
    } else {
      title = "El promedio no está creando déficit";
      copy = "Confirma los datos antes de cambiar comida o entrenamiento. Unos pocos días pueden distorsionar la lectura.";
    }
  }
  $("#insight-title").textContent = title;
  $("#insight-copy").textContent = copy;
}

function renderProgress() {
  const model = currentModel();
  const entries = model.entries;
  const proteinValues = recentEntries(entries, 7).map(entry => safeNumber(entry.protein)).filter(value => value !== null);
  const proteinAverage = proteinValues.length ? proteinValues.reduce((sum, value) => sum + value, 0) / proteinValues.length : null;
  const weeklyLoss = model.weeklyDeficit === null ? null : model.weeklyDeficit * 7 / KCAL_PER_KG;
  const consistent = consistency(entries, state.settings, 28);

  $("#progress-stats").innerHTML = [
    metricCard("∆", weeklyLoss === null ? "Sin dato" : `${formatNumber(weeklyLoss, 2)} kg`, "ritmo teórico semanal", "green"),
    metricCard("P", proteinAverage === null ? "Sin dato" : `${formatNumber(proteinAverage)} g`, "proteína media 7 días", "blue"),
    metricCard("⚡", `${formatNumber(model.tdee)} kcal`, entries.length >= 7 ? "gasto adaptativo" : "gasto estimado", "coral"),
    metricCard("✓", `${consistent.score}%`, "días sólidos registrados", "purple")
  ].join("");
  $("#consistency-score").textContent = `${consistent.score}%`;
  renderWeightChart(entries);
  renderHeatmap(entries, model.tdee);
  renderWorkouts();
}

function renderWeightChart(entries) {
  const weighted = entries.filter(entry => safeNumber(entry.weight) !== null).slice(-30);
  const svg = $("#weight-chart");
  if (weighted.length < 2) {
    svg.innerHTML = `<text x="320" y="120" text-anchor="middle" class="empty-chart">Registra al menos dos pesajes</text>`;
    $("#weight-change").textContent = "Sin datos";
    return;
  }
  const values = weighted.map(entry => Number(entry.weight));
  const smoothed = movingAverage(values, 7);
  const min = Math.min(...values, ...smoothed) - 0.5;
  const max = Math.max(...values, ...smoothed) + 0.5;
  const point = (value, index) => {
    const x = 24 + (index / (values.length - 1)) * 592;
    const y = 205 - ((value - min) / (max - min)) * 170;
    return `${round(x, 1)},${round(y, 1)}`;
  };
  const rawPath = values.map(point).join(" ");
  const averagePath = smoothed.map(point).join(" ");
  svg.innerHTML = `
    <line x1="24" y1="205" x2="616" y2="205" class="chart-grid" />
    <line x1="24" y1="35" x2="616" y2="35" class="chart-grid" />
    <polyline points="${rawPath}" class="weight-raw" />
    <polyline points="${averagePath}" class="weight-average" />
    <circle cx="${point(smoothed.at(-1), smoothed.length - 1).split(",")[0]}" cy="${point(smoothed.at(-1), smoothed.length - 1).split(",")[1]}" r="7" class="last-point" />
    <text x="24" y="26" class="chart-label">${formatNumber(max, 1)} kg</text>
    <text x="24" y="229" class="chart-label">${formatNumber(min, 1)} kg</text>`;
  const change = smoothed.at(-1) - smoothed[0];
  $("#weight-change").textContent = `${change > 0 ? "+" : ""}${formatNumber(change, 1)} kg`;
}

function renderHeatmap(entries, tdee) {
  const byDate = new Map(entries.map(entry => [entry.date, entry]));
  const days = [];
  for (let offset = 27; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const iso = date.toISOString().slice(0, 10);
    const entry = byDate.get(iso);
    let level = 0;
    if (entry) {
      const deficit = deficitForEntry(entry, tdee);
      const protein = safeNumber(entry.protein);
      if (deficit !== null) level = deficit > 150 ? 2 : 1;
      if (deficit !== null && deficit > 150 && protein !== null && protein >= state.settings.proteinTarget * 0.9) level = 3;
    }
    days.push(`<i class="level-${level}" title="${iso}"></i>`);
  }
  $("#heatmap").innerHTML = days.join("");
}

function renderWorkouts() {
  const workouts = [...state.workouts].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
  const weekAgo = Date.now() - 7 * 86400000;
  const weekly = workouts.filter(workout => new Date(workout.start_time).getTime() >= weekAgo);
  $("#workout-count").textContent = `${weekly.length} esta semana`;
  $("#workout-list").innerHTML = workouts.slice(0, 5).map(workout => {
    const sets = (workout.exercises ?? []).reduce((sum, exercise) => sum + (exercise.sets?.length ?? 0), 0);
    const minutes = workout.start_time && workout.end_time ? Math.max(0, Math.round((new Date(workout.end_time) - new Date(workout.start_time)) / 60000)) : null;
    return `<div class="workout-row"><span>🏆</span><div><strong>${escapeHTML(workout.title || "Entrenamiento")}</strong><small>${new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" }).format(new Date(workout.start_time))} · ${sets} series${minutes ? ` · ${minutes} min` : ""}</small></div></div>`;
  }).join("") || `<p class="empty-state">Sin entrenamientos. Conecta Hevy en Ajustes.</p>`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function renderSettings() {
  const form = $("#settings-form");
  Object.entries(state.settings).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value ?? "";
  });
}

function renderEntryForm(date = todayISO()) {
  const form = $("#daily-form");
  const entry = state.entries.find(item => item.date === date);
  form.reset();
  form.elements.date.value = date;
  if (entry) Object.entries(entry).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ""; });
  $("#delete-entry").classList.toggle("hidden", !entry);
}

function renderAll() {
  renderToday();
  renderProgress();
  renderSettings();
  renderFoods();
  if (!$("#entry-date").value) renderEntryForm();
}

function navigate(target) {
  $$(".view").forEach(view => view.classList.toggle("active", view.dataset.view === target));
  $$(".tabbar button").forEach(button => button.classList.toggle("active", button.dataset.target === target));
  if (target === "log") renderEntryForm($("#entry-date").value || todayISO());
  if (target === "progress") renderProgress();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formNumbers(form, fields) {
  return Object.fromEntries(fields.map(field => [field, safeNumber(form.elements[field]?.value)]));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function updateLocalNutrition(day) {
  const totals = totalsForDay(state.foods, day);
  const previous = state.entries.find(entry => entry.date === day) ?? { date: day };
  state.entries = state.entries.filter(entry => entry.date !== day);
  state.entries.push({
    ...previous,
    calories: state.foods.some(food => !food.deletedAt && localDay(food.consumedAt) === day) ? Math.round(totals.calories) : null,
    protein: state.foods.some(food => !food.deletedAt && localDay(food.consumedAt) === day) ? Math.round(totals.protein * 10) / 10 : null
  });
}

function clearSelectedFoodImage() {
  if (selectedFoodImage?.previewURL) URL.revokeObjectURL(selectedFoodImage.previewURL);
  selectedFoodImage = null;
  $("#food-camera-input").value = "";
  $("#food-library-input").value = "";
  $("#capture-preview-wrap").classList.add("hidden");
  $("#capture-preview").removeAttribute("src");
}

function openFoodDialog({ camera = false } = {}) {
  if (!cloud.isSignedIn) {
    showAuthDialog();
    return;
  }
  clearSelectedFoodImage();
  $("#food-capture-form").reset();
  $("#food-analysis-status").textContent = "";
  const dialog = $("#food-dialog");
  if (!dialog.open) dialog.showModal();
  if (camera) setTimeout(() => $("#food-camera-input").click(), 120);
  else setTimeout(() => $("#food-text").focus(), 120);
}

async function compressFoodImage(file) {
  const objectURL = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectURL;
    await image.decode();
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("No se pudo preparar la foto")), "image/jpeg", 0.78));
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { blob, base64, mimeType: "image/jpeg", previewURL: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

async function selectFoodImage(file) {
  if (!file) return;
  $("#food-analysis-status").textContent = "Preparando foto…";
  try {
    clearSelectedFoodImage();
    selectedFoodImage = await compressFoodImage(file);
    $("#capture-preview").src = selectedFoodImage.previewURL;
    $("#capture-preview-wrap").classList.remove("hidden");
    $("#food-analysis-status").textContent = "Foto lista. Analizando…";
    await analyzeAndAddFood();
  } catch (error) {
    $("#food-analysis-status").textContent = error.message;
  }
}

async function analyzeAndAddFood(event) {
  event?.preventDefault();
  const text = $("#food-text").value.trim();
  if (!text && !selectedFoodImage) {
    $("#food-analysis-status").textContent = "Escribe algo o añade una foto.";
    return;
  }
  const button = $("#analyze-food");
  if (button.disabled) return;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> Reconociendo…`;
  $("#food-analysis-status").textContent = "Calculando porciones, calorías y macros…";
  try {
    const raw = await cloud.analyzeFood({
      text,
      imageBase64: selectedFoodImage?.base64 ?? "",
      mimeType: selectedFoodImage?.mimeType ?? "image/jpeg"
    });
    const analysis = normalizeFoodAnalysis(raw);
    const id = crypto.randomUUID();
    let imagePath = null;
    if (selectedFoodImage) {
      try { imagePath = await cloud.uploadFoodImage(selectedFoodImage.blob, id); } catch { imagePath = null; }
    }
    const food = {
      id,
      consumedAt: new Date().toISOString(),
      meal: analysis.meal,
      name: analysis.name,
      amountDescription: analysis.amountDescription,
      calories: analysis.calories,
      protein: analysis.protein,
      carbohydrates: analysis.carbohydrates,
      fat: analysis.fat,
      confidence: analysis.confidence,
      source: selectedFoodImage ? "photo_ai" : "text_ai",
      inputText: text,
      imagePath,
      assumptions: analysis.assumptions,
      clientUpdatedAt: new Date().toISOString()
    };
    state.foods.unshift(food);
    updateLocalNutrition(localDay(food.consumedAt));
    saveState();
    const saved = await cloud.mutate("food-upsert", food);
    $("#food-dialog").close();
    clearSelectedFoodImage();
    renderAll();
    showToast(saved ? `${food.name}, ${formatNumber(food.calories)} kcal añadidas.` : "Registro guardado. Se sincronizará al recuperar conexión.");
  } catch (error) {
    $("#food-analysis-status").textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = `<span>✦</span> Analizar y añadir`;
  }
}

function openFoodEditor(id) {
  const food = state.foods.find(item => item.id === id);
  if (!food) return;
  const form = $("#food-edit-form");
  for (const field of ["id", "name", "amountDescription", "calories", "protein", "carbohydrates", "fat"]) {
    form.elements[field].value = food[field] ?? "";
  }
  $("#food-assumptions").textContent = food.assumptions?.length ? `Supuestos: ${food.assumptions.join(" · ")}` : "Estimación de la IA. Ajusta cualquier dato si conoces la etiqueta o la cantidad exacta.";
  $("#food-edit-dialog").showModal();
}

async function saveFoodCorrection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const food = state.foods.find(item => item.id === form.elements.id.value);
  if (!food) return;
  const oldDay = localDay(food.consumedAt);
  Object.assign(food, {
    name: form.elements.name.value.trim(),
    amountDescription: form.elements.amountDescription.value.trim(),
    calories: Number(form.elements.calories.value),
    protein: Number(form.elements.protein.value),
    carbohydrates: Number(form.elements.carbohydrates.value),
    fat: Number(form.elements.fat.value),
    confidence: 1,
    clientUpdatedAt: new Date().toISOString()
  });
  updateLocalNutrition(oldDay);
  saveState();
  await cloud.mutate("food-upsert", food);
  $("#food-edit-dialog").close();
  renderAll();
  showToast("Corrección guardada.");
}

async function deleteSelectedFood() {
  const id = $("#food-edit-form").elements.id.value;
  const food = state.foods.find(item => item.id === id);
  if (!food || !confirm(`¿Eliminar ${food.name}?`)) return;
  const day = localDay(food.consumedAt);
  state.foods = state.foods.filter(item => item.id !== id);
  updateLocalNutrition(day);
  saveState();
  await cloud.mutate("food-delete", { id });
  if (food.imagePath) cloud.deleteFoodImage(food.imagePath).catch(() => {});
  $("#food-edit-dialog").close();
  renderAll();
  showToast("Registro eliminado.");
}

function updateAccountUI() {
  const email = cloud.user?.email || "Sesión no iniciada";
  $("#account-email").textContent = email;
  $("#pending-count").textContent = `${cloud.pendingCount} pendiente${cloud.pendingCount === 1 ? "" : "s"}`;
}

function readableSyncDate(value) {
  if (!value) return "Esperando la primera sincronización.";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Sincronización recibida.";
  return `Última sincronización: ${new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short" }).format(date)}`;
}

function setIntegrationStatus(provider, payload = {}) {
  const connected = Boolean(payload.connected);
  const error = payload.status === "error" || Boolean(payload.last_error);
  const dot = $(`#${provider}-connection-dot`);
  dot.className = `connection-dot${error ? " error" : connected ? " connected" : ""}`;
  $(`#${provider}-connection-title`).textContent = error ? "Necesita atención" : connected ? "Conectado" : "Sin conectar";
  $(`#${provider}-sync-status`).textContent = error
    ? String(payload.last_error || "La última sincronización falló.")
    : connected
      ? readableSyncDate(payload.last_sync_at)
      : provider === "hevy"
        ? "Se sincronizará desde la nube aunque CutTrack esté cerrado."
        : "Todavía no se han recibido datos.";
  if (provider === "hevy") {
    $("#hevy-connect-form").classList.toggle("hidden", connected);
    $("#hevy-connected-actions").classList.toggle("hidden", !connected);
  }
}

async function refreshIntegrations() {
  updateHealthExportLink();
  if (!cloud.isSignedIn) {
    setIntegrationStatus("health", {});
    setIntegrationStatus("hevy", {});
    return;
  }
  const [health, hevy] = await Promise.allSettled([
    cloud.healthIntegration("status"),
    cloud.hevyIntegration("status")
  ]);
  setIntegrationStatus("health", health.status === "fulfilled" ? health.value : { status: "error", last_error: health.reason?.message });
  setIntegrationStatus("hevy", hevy.status === "fulfilled" ? hevy.value : { status: "error", last_error: hevy.reason?.message });
}

function healthExportLink({ endpoint, token, workouts = false }) {
  const parameters = {
    url: endpoint,
    name: workouts ? "CutTrack entrenamientos" : "CutTrack salud",
    format: "json",
    datatype: workouts ? "workouts" : "healthMetrics",
    period: "none",
    exportversion: "v2",
    syncinterval: "hours",
    syncquantity: "2",
    headers: `X-API-Key,${token}`,
    requesttimeout: "60",
    batchrequests: "false",
    notifyonupdate: "false",
    notifywhenrun: "false",
    enabled: "true"
  };
  if (workouts) {
    parameters.includeroutes = "false";
    parameters.includeworkoutmetadata = "true";
    parameters.workoutsmetadatainterval = "minutes";
  } else {
    parameters.metrics = "Step Count,Active Energy,Basal Energy Burned,Resting Heart Rate,Sleep Analysis,Weight & Body Mass,Body Fat Percentage";
    parameters.interval = "days";
    parameters.aggregatedata = "true";
    parameters.aggregatesleep = "true";
  }
  const query = Object.entries(parameters)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `com.HealthExport://automation?${query}`;
}

function updateHealthExportLink() {
  let connection;
  try {
    connection = JSON.parse(localStorage.getItem(healthExportTokenKey()));
  } catch {
    connection = null;
  }
  const link = $("#open-health-export");
  link.classList.toggle("hidden", !connection?.token || !connection?.endpoint);
  if (connection?.token && connection?.endpoint) link.href = healthExportLink(connection);
}

async function setupHealthExport() {
  if (!cloud.isSignedIn) return showAuthDialog();
  const button = $("#setup-health-export");
  button.disabled = true;
  try {
    const connection = await cloud.healthIntegration("create");
    localStorage.setItem(healthExportTokenKey(), JSON.stringify({ token: connection.token, endpoint: connection.endpoint }));
    updateHealthExportLink();
    setIntegrationStatus("health", connection);
    showToast("Abriendo la configuración de Salud…");
    window.location.href = healthExportLink(connection);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function setupHealthWorkouts() {
  let connection;
  try {
    connection = JSON.parse(localStorage.getItem(healthExportTokenKey()));
  } catch {
    connection = null;
  }
  if (!connection?.token || !connection?.endpoint) {
    showToast("Pulsa primero Conectar datos de Salud.");
    return;
  }
  showToast("Abriendo la configuración de entrenamientos…");
  window.location.href = healthExportLink({ ...connection, workouts: true });
}

async function disconnectHealthExport() {
  if (!confirm("¿Desconectar los envíos de Apple Salud? Los datos ya guardados se conservarán.")) return;
  try {
    const result = await cloud.healthIntegration("revoke");
    localStorage.removeItem(healthExportTokenKey());
    updateHealthExportLink();
    setIntegrationStatus("health", result);
    showToast("Apple Salud desconectado.");
  } catch (error) {
    showToast(error.message);
  }
}

function updateCloudStatus({ status, detail = "", pending = cloud.pendingCount }) {
  const labels = {
    online: pending ? `${pending} cambios pendientes` : "Guardado en tu cuenta",
    syncing: "Sincronizando…",
    pending: `${pending} cambios pendientes`,
    offline: "Sin conexión, cambios guardados aquí",
    error: "No se pudo sincronizar",
    "signed-out": "Inicia sesión"
  };
  const text = labels[status] ?? detail ?? "";
  $("#cloud-status").textContent = text;
  $("#cloud-status").className = `cloud-status ${status}`;
  $("#account-sync-status").textContent = detail || text;
  updateAccountUI();
  if (status === "signed-out") {
    state = structuredClone(defaultState);
    renderEntryForm(todayISO());
    renderAll();
    refreshIntegrations();
  }
}

async function uploadCurrentState() {
  await cloud.mutate("profile-upsert", state.settings);
  for (const entry of state.entries) await cloud.mutate("entry-upsert", entry);
  for (const food of state.foods) await cloud.mutate("food-upsert", food);
}

async function syncCloud({ quiet = false } = {}) {
  if (!cloud.isSignedIn) {
    showAuthDialog();
    return null;
  }
  if (cloudSyncPromise) return cloudSyncPromise;
  cloudSyncPromise = (async () => {
    try {
      const remote = await cloud.sync(state, defaultState);
      if (remote) {
        state = remote;
        saveState();
        renderEntryForm($("#entry-date").value || todayISO());
        renderAll();
      }
      if (!quiet) showToast("Todo sincronizado.");
      return remote;
    } catch (error) {
      if (!quiet) showToast(error.message);
      if (!cloud.isSignedIn) showAuthDialog();
      return null;
    } finally {
      cloudSyncPromise = null;
      updateAccountUI();
    }
  })();
  return cloudSyncPromise;
}

function showAuthDialog() {
  const dialog = $("#auth-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeAuthDialog() {
  const dialog = $("#auth-dialog");
  if (dialog.open) dialog.close();
  $("#auth-message").textContent = "";
}

async function completeSignIn() {
  closeAuthDialog();
  state = loadState();
  renderEntryForm($("#entry-date").value || todayISO());
  renderAll();
  updateAccountUI();
  const remote = await syncCloud({ quiet: true });
  if (!cloud.isSignedIn) {
    showAuthDialog();
    return;
  }
  if (!remote?.configured && !state.configured) $("#onboarding-dialog").showModal();
  refreshIntegrations();
  updateHealthExportLink();
}

async function initializeCloud() {
  cloud.subscribe(updateCloudStatus);
  updateAccountUI();
  if (!cloud.isSignedIn) {
    updateCloudStatus({ status: "signed-out", detail: "Tu cuenta protege el historial" });
    showAuthDialog();
    return;
  }
  await completeSignIn();
}

async function seedDemo() {
  const entries = [];
  const weights = [82.5, 82.4, 82.2, 82.3, 82.0, 81.9, 81.8, 81.7, 81.6, 81.7, 81.4, 81.3, 81.2, 81.1];
  const calories = [1840, 1970, 1760, 2080, 1890, 1920, 1810, 1730, 2010, 1880, 1790, 1940, 1860, 1750];
  for (let index = 0; index < 14; index++) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (13 - index));
    entries.push({
      date: date.toISOString().slice(0, 10), calories: calories[index], protein: 165 + (index % 5) * 6,
      weight: weights[index], bodyFat: index === 13 ? 21.5 : null, activeEnergy: 620 + (index % 4) * 70,
      basalEnergy: 1930, steps: 7200 + index * 310, sleep: 6.8 + (index % 4) * 0.3
    });
  }
  state = {
    ...structuredClone(defaultState), configured: true,
    settings: { ...defaultState.settings, currentWeight: 81.1, currentBodyFat: 21.5 }, entries,
    workouts: [{ id: "demo-1", title: "Upper Strength", start_time: new Date(Date.now() - 86400000).toISOString(), end_time: new Date(Date.now() - 86400000 + 72 * 60000).toISOString(), exercises: [{ sets: Array(22).fill({}) }] }]
  };
  saveState();
  if (cloud.isSignedIn) await uploadCurrentState();
  $("#onboarding-dialog").close();
  renderEntryForm();
  renderAll();
  showToast("Demo cargada. Puedes borrar los datos en Ajustes.");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cuttrack-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const imported = JSON.parse(await file.text());
    if (imported.version !== 1 || !Array.isArray(imported.entries) || !imported.settings) throw new Error("Archivo incompatible");
    state = { ...structuredClone(defaultState), ...imported, settings: { ...defaultState.settings, ...imported.settings } };
    saveState();
    if (cloud.isSignedIn) await uploadCurrentState();
    renderEntryForm();
    renderAll();
    showToast("Datos importados.");
  } catch (error) {
    showToast(`No se pudo importar: ${error.message}`);
  }
}

function bindEvents() {
  $$(".tabbar button").forEach(button => button.addEventListener("click", () => navigate(button.dataset.target)));
  $("#camera-shortcut").addEventListener("click", () => openFoodDialog({ camera: true }));
  $("#text-shortcut").addEventListener("click", () => openFoodDialog());
  $("#log-food-button").addEventListener("click", () => openFoodDialog());
  $("#food-capture-form").addEventListener("submit", analyzeAndAddFood);
  $("#capture-camera").addEventListener("click", () => $("#food-camera-input").click());
  $("#capture-library").addEventListener("click", () => $("#food-library-input").click());
  $("#food-camera-input").addEventListener("change", event => selectFoodImage(event.target.files[0]));
  $("#food-library-input").addEventListener("change", event => selectFoodImage(event.target.files[0]));
  $("#remove-capture-photo").addEventListener("click", clearSelectedFoodImage);
  $(".close-food-dialog").addEventListener("click", () => { $("#food-dialog").close(); clearSelectedFoodImage(); });
  $(".close-food-edit").addEventListener("click", () => $("#food-edit-dialog").close());
  $("#food-edit-form").addEventListener("submit", saveFoodCorrection);
  $("#delete-food").addEventListener("click", deleteSelectedFood);
  document.addEventListener("click", event => {
    const row = event.target.closest("[data-food-id]");
    if (row) openFoodEditor(row.dataset.foodId);
    if (event.target.closest("#empty-food-add")) openFoodDialog();
  });
  $("#entry-date").addEventListener("change", event => renderEntryForm(event.target.value));
  $("#daily-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const existing = state.entries.find(item => item.date === form.elements.date.value) ?? {};
    const entry = { ...existing, date: form.elements.date.value, ...formNumbers(form, ["calories", "protein"]) };
    state.entries = state.entries.filter(item => item.date !== entry.date);
    state.entries.push(entry);
    saveState();
    const cloudSaved = await cloud.mutate("entry-upsert", entry);
    renderAll();
    navigate("today");
    showToast(cloudSaved ? "Día guardado en tu cuenta." : "Día guardado aquí. Se subirá al recuperar conexión.");
  });
  $("#delete-entry").addEventListener("click", async () => {
    const date = $("#entry-date").value;
    if (!confirm(`¿Eliminar el registro del ${date}?`)) return;
    state.entries = state.entries.filter(entry => entry.date !== date);
    saveState();
    await cloud.mutate("entry-delete", date);
    renderEntryForm(date);
    renderAll();
    showToast("Registro eliminado.");
  });
  $("#settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    state.settings = { ...state.settings, ...formNumbers(event.currentTarget, ["calorieTarget", "proteinTarget", "tdeeEstimate", "mainBodyFatTarget", "currentWeight", "currentBodyFat"]) };
    state.configured = true;
    saveState();
    const cloudSaved = await cloud.mutate("profile-upsert", state.settings);
    renderAll();
    showToast(cloudSaved ? "Ajustes guardados en tu cuenta." : "Ajustes pendientes de sincronizar.");
  });
  $("#onboarding-form").addEventListener("submit", async event => {
    event.preventDefault();
    state.settings = { ...state.settings, ...formNumbers(event.currentTarget, ["calorieTarget", "proteinTarget", "tdeeEstimate", "mainBodyFatTarget"]) };
    state.configured = true;
    saveState();
    await cloud.mutate("profile-upsert", state.settings);
    $("#onboarding-dialog").close();
    renderAll();
  });
  $("#load-demo").addEventListener("click", seedDemo);
  $("#export-data").addEventListener("click", exportData);
  $("#import-data").addEventListener("change", event => event.target.files[0] && importData(event.target.files[0]));
  $("#reset-data").addEventListener("click", async () => {
    if (!confirm("¿Borrar la copia local de CutTrack? Los datos de tu cuenta seguirán en la nube.")) return;
    const key = storageKey();
    if (key) localStorage.removeItem(key);
    state = structuredClone(defaultState);
    renderEntryForm();
    renderAll();
    await syncCloud({ quiet: true });
    showToast("Copia local renovada desde tu cuenta.");
  });
  $("#sync-cloud").addEventListener("click", () => syncCloud());
  $("#setup-health-export").addEventListener("click", setupHealthExport);
  $("#setup-health-workouts").addEventListener("click", setupHealthWorkouts);
  $("#disconnect-health-export").addEventListener("click", disconnectHealthExport);
  $("#hevy-connect-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await cloud.hevyIntegration("connect", form.elements.apiKey.value);
      form.reset();
      setIntegrationStatus("hevy", result);
      await syncCloud({ quiet: true });
      showToast(`${result.workouts ?? 0} entrenamientos sincronizados.`);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#sync-hevy-now").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await cloud.hevyIntegration("sync");
      setIntegrationStatus("hevy", result);
      await syncCloud({ quiet: true });
      showToast(`${result.workouts ?? 0} entrenamientos sincronizados.`);
    } catch (error) {
      showToast(error.message);
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  $("#disconnect-hevy").addEventListener("click", async () => {
    if (!confirm("¿Desconectar Hevy? Los entrenamientos ya guardados se conservarán.")) return;
    try {
      const result = await cloud.hevyIntegration("disconnect");
      setIntegrationStatus("hevy", result);
      showToast("Hevy desconectado.");
    } catch (error) {
      showToast(error.message);
    }
  });
  $("#sign-out").addEventListener("click", async () => {
    await cloud.signOut();
    state = structuredClone(defaultState);
    renderEntryForm(todayISO());
    renderAll();
    updateAccountUI();
    showAuthDialog();
  });
  $("#auth-dialog").addEventListener("cancel", event => event.preventDefault());
  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("#sign-in");
    button.disabled = true;
    $("#auth-message").textContent = "Entrando…";
    try {
      await cloud.signIn(form.elements.email.value.trim(), form.elements.password.value);
      form.elements.password.value = "";
      await completeSignIn();
    } catch (error) {
      $("#auth-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#sign-up").addEventListener("click", async () => {
    const form = $("#auth-form");
    if (!form.reportValidity()) return;
    const button = $("#sign-up");
    button.disabled = true;
    $("#auth-message").textContent = "Creando tu cuenta…";
    try {
      const result = await cloud.signUp(form.elements.email.value.trim(), form.elements.password.value);
      form.elements.password.value = "";
      if (result.confirmationRequired) {
        $("#auth-message").textContent = "Revisa tu email y confirma la cuenta. Después vuelve aquí y entra.";
      } else {
        await completeSignIn();
      }
    } catch (error) {
      $("#auth-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $$("[data-dialog]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.dialog}`).showModal()));
  $$(".close-dialog").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#install-button").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } else {
      $("#install-dialog").showModal();
    }
  });
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstallPrompt = event; });
  window.addEventListener("online", () => syncCloud({ quiet: true }));
  window.addEventListener("offline", () => updateCloudStatus({ status: "offline", detail: "Sin conexión" }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && cloud.isSignedIn) {
      refreshIntegrations();
      syncCloud({ quiet: true });
    }
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

bindEvents();
renderEntryForm();
renderAll();
registerServiceWorker();
initializeCloud();
