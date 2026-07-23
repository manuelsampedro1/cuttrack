function arrayFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.workouts)) return payload.workouts;
  if (Array.isArray(payload?.data?.workouts)) return payload.data.workouts;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function normalizeHevyWorkouts(payload, syncedAt = new Date().toISOString()) {
  return arrayFrom(payload).flatMap((workout) => {
    const id = String(workout?.id ?? "").trim();
    const startedAt = String(workout?.start_time ?? workout?.started_at ?? "").trim();
    const endedAt = String(workout?.end_time ?? workout?.ended_at ?? startedAt).trim();
    if (!id || !startedAt || !Number.isFinite(new Date(startedAt).getTime())) return [];
    return [{
      source_id: id,
      title: String(workout?.title ?? "Entrenamiento").slice(0, 180),
      started_at: new Date(startedAt).toISOString(),
      ended_at: Number.isFinite(new Date(endedAt).getTime()) ? new Date(endedAt).toISOString() : new Date(startedAt).toISOString(),
      payload: workout,
      client_updated_at: syncedAt,
    }];
  });
}
