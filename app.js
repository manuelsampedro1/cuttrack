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

const STORAGE_KEY = "cuttrack.v1";
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
  workouts: []
};

let state = loadState();
let deferredInstallPrompt = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const formatNumber = (value, digits = 0) => Number(value).toLocaleString("es-ES", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const formatDate = date => new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(date);
const todayISO = () => new Date().toISOString().slice(0, 10);

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored || stored.version !== 1) return structuredClone(defaultState);
    return {
      ...structuredClone(defaultState),
      ...stored,
      settings: { ...defaultState.settings, ...stored.settings },
      entries: Array.isArray(stored.entries) ? stored.entries : [],
      workouts: Array.isArray(stored.workouts) ? stored.workouts : []
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  if (!$("#entry-date").value) renderEntryForm();
}

function navigate(target) {
  $$(".view").forEach(view => view.classList.toggle("active", view.dataset.view === target));
  $$(".tabbar button").forEach(button => button.classList.toggle("active", button.dataset.target === target));
  $("#quick-add").classList.toggle("hidden", target === "log" || target === "settings");
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

function seedDemo() {
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
  $("#onboarding-dialog").close();
  renderEntryForm();
  renderAll();
  showToast("Demo cargada. Puedes borrar los datos en Ajustes.");
}

async function syncHevy() {
  const key = $("#hevy-key").value.trim();
  if (!key) return showToast("Introduce tu API key de Hevy.");
  const button = $("#sync-hevy");
  button.disabled = true;
  button.textContent = "Sincronizando…";
  $("#hevy-status").textContent = "Descargando entrenamientos. La clave no se guardará.";
  try {
    const workouts = [];
    let page = 1;
    while (page <= 20) {
      const response = await fetch(`https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=10`, { headers: { "api-key": key } });
      if (!response.ok) throw new Error(response.status === 401 ? "Clave no válida" : `Hevy respondió ${response.status}`);
      const payload = await response.json();
      const batch = Array.isArray(payload) ? payload : payload.workouts ?? payload.data ?? [];
      workouts.push(...batch);
      const pageCount = payload.page_count ?? payload.pageCount;
      if (!batch.length || batch.length < 10 || (pageCount && page >= pageCount)) break;
      page += 1;
    }
    const byID = new Map(state.workouts.map(workout => [workout.id, workout]));
    workouts.forEach(workout => byID.set(workout.id, workout));
    state.workouts = [...byID.values()];
    saveState();
    renderProgress();
    $("#hevy-key").value = "";
    $("#hevy-status").textContent = `${workouts.length} entrenamientos recibidos. La clave se ha retirado del campo.`;
    showToast("Hevy sincronizado.");
  } catch (error) {
    $("#hevy-status").textContent = error.message;
    showToast(`No se pudo sincronizar: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Sincronizar ahora";
  }
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
    renderEntryForm();
    renderAll();
    showToast("Datos importados.");
  } catch (error) {
    showToast(`No se pudo importar: ${error.message}`);
  }
}

function bindEvents() {
  $$(".tabbar button").forEach(button => button.addEventListener("click", () => navigate(button.dataset.target)));
  $("#quick-add").addEventListener("click", () => navigate("log"));
  $("#entry-date").addEventListener("change", event => renderEntryForm(event.target.value));
  $("#daily-form").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget;
    const entry = { date: form.elements.date.value, ...formNumbers(form, ["calories", "protein", "weight", "bodyFat", "activeEnergy", "basalEnergy", "steps", "sleep"]) };
    state.entries = state.entries.filter(item => item.date !== entry.date);
    state.entries.push(entry);
    if (entry.weight) state.settings.currentWeight = entry.weight;
    if (entry.bodyFat) state.settings.currentBodyFat = entry.bodyFat;
    saveState();
    renderAll();
    navigate("today");
    showToast("Día guardado.");
  });
  $("#delete-entry").addEventListener("click", () => {
    const date = $("#entry-date").value;
    if (!confirm(`¿Eliminar el registro del ${date}?`)) return;
    state.entries = state.entries.filter(entry => entry.date !== date);
    saveState();
    renderEntryForm(date);
    renderAll();
    showToast("Registro eliminado.");
  });
  $("#settings-form").addEventListener("submit", event => {
    event.preventDefault();
    state.settings = { ...state.settings, ...formNumbers(event.currentTarget, ["calorieTarget", "proteinTarget", "tdeeEstimate", "mainBodyFatTarget", "currentWeight", "currentBodyFat"]) };
    state.configured = true;
    saveState();
    renderAll();
    showToast("Ajustes guardados.");
  });
  $("#onboarding-form").addEventListener("submit", event => {
    event.preventDefault();
    state.settings = { ...state.settings, ...formNumbers(event.currentTarget, ["calorieTarget", "proteinTarget", "tdeeEstimate", "mainBodyFatTarget", "currentWeight", "currentBodyFat"]) };
    state.configured = true;
    saveState();
    $("#onboarding-dialog").close();
    renderAll();
  });
  $("#load-demo").addEventListener("click", seedDemo);
  $("#sync-hevy").addEventListener("click", syncHevy);
  $("#export-data").addEventListener("click", exportData);
  $("#import-data").addEventListener("change", event => event.target.files[0] && importData(event.target.files[0]));
  $("#reset-data").addEventListener("click", () => {
    if (!confirm("¿Borrar todos los datos locales de CutTrack? Esta acción no se puede deshacer.")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(defaultState);
    renderEntryForm();
    renderAll();
    $("#onboarding-dialog").showModal();
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
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

bindEvents();
renderEntryForm();
renderAll();
registerServiceWorker();
if (!state.configured && new URLSearchParams(location.search).get("demo") === "1") {
  seedDemo();
} else if (!state.configured) {
  $("#onboarding-dialog").showModal();
}
