const SUM_METRICS = new Map([
  ["step_count", "steps"],
  ["active_energy", "active_energy"],
  ["active_energy_burned", "active_energy"],
  ["basal_energy", "basal_energy"],
  ["basal_energy_burned", "basal_energy"],
  ["resting_energy", "basal_energy"],
]);

const LAST_METRICS = new Map([
  ["weight_&_body_mass", "weight"],
  ["weight_body_mass", "weight"],
  ["body_mass", "weight"],
  ["weight", "weight"],
  ["body_fat_percentage", "body_fat"],
  ["resting_heart_rate", "resting_heart_rate"],
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dayFrom(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function isoDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/,
    "$1T$2$3:$4",
  );
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function convert(value, units, field) {
  let number = finite(value);
  if (number === null) return null;
  const unit = String(units ?? "").trim().toLowerCase();
  if (field === "weight" && ["lb", "lbs", "pound", "pounds"].includes(unit)) number *= 0.45359237;
  if ((field === "active_energy" || field === "basal_energy") && ["kj", "kilojoule", "kilojoules"].includes(unit)) number /= 4.184;
  if (field === "body_fat" && number > 0 && number <= 1.5) number *= 100;
  return Math.round(number * 100) / 100;
}

function sleepHours(point, units) {
  const value = finite(point?.totalSleep ?? point?.asleep ?? point?.qty);
  if (value === null) return null;
  const unit = String(units ?? "").toLowerCase();
  if (unit.startsWith("min")) return value / 60;
  if (unit.startsWith("sec")) return value / 3600;
  return value;
}

function valueFromPoint(point) {
  return finite(point?.qty ?? point?.Avg ?? point?.avg ?? point?.value);
}

function ensureDay(days, day) {
  if (!days.has(day)) days.set(day, { day });
  return days.get(day);
}

export function parseHealthExport(payload, receivedAt = new Date().toISOString()) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const metrics = Array.isArray(root?.metrics) ? root.metrics : [];
  const days = new Map();

  for (const metric of metrics) {
    const name = String(metric?.name ?? "").trim().toLowerCase().replaceAll(" ", "_");
    const points = Array.isArray(metric?.data) ? metric.data : [];
    if (name === "sleep_analysis") {
      for (const point of points) {
        const day = dayFrom(point?.date ?? point?.sleepEnd ?? point?.endDate);
        const value = sleepHours(point, metric?.units);
        if (!day || value === null) continue;
        ensureDay(days, day).sleep_hours = Math.round(value * 100) / 100;
      }
      continue;
    }

    const sumField = SUM_METRICS.get(name);
    const lastField = LAST_METRICS.get(name);
    if (!sumField && !lastField) continue;
    for (const point of points) {
      const day = dayFrom(point?.date ?? point?.startDate ?? point?.endDate);
      if (!day) continue;
      const field = sumField ?? lastField;
      const raw = valueFromPoint(point);
      const value = convert(raw, metric?.units, field);
      if (value === null) continue;
      const row = ensureDay(days, day);
      row[field] = sumField ? Math.round(((row[field] ?? 0) + value) * 100) / 100 : value;
    }
  }

  const rawWorkouts = Array.isArray(root?.workouts) ? root.workouts : [];
  const workouts = rawWorkouts.flatMap((workout, index) => {
    const startedAt = isoDate(workout?.start ?? workout?.start_time);
    const endedAt = isoDate(workout?.end ?? workout?.end_time) ?? startedAt;
    if (!startedAt || !endedAt) return [];
    const id = String(workout?.id ?? `${startedAt}-${index}`);
    const title = String(workout?.name ?? workout?.title ?? "Entrenamiento").slice(0, 180);
    return [{
      source_id: id,
      title,
      started_at: startedAt,
      ended_at: endedAt,
      payload: {
        ...workout,
        id,
        title,
        start_time: startedAt,
        end_time: endedAt,
        exercises: Array.isArray(workout?.exercises) ? workout.exercises : [],
      },
      client_updated_at: receivedAt,
    }];
  });

  return {
    healthDays: [...days.values()].map((row) => ({
      ...row,
      health_updated_at: receivedAt,
      source: "health_auto_export",
    })),
    workouts,
  };
}
