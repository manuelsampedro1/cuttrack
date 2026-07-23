import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const SESSION_KEY = "cuttrack.cloud.session.v1";
const OUTBOX_KEY = "cuttrack.cloud.outbox.v1";

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function compactSession(payload) {
  if (!payload?.access_token || !payload?.refresh_token || !payload?.user?.id) return null;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at ?? Math.floor(Date.now() / 1000) + Number(payload.expires_in ?? 3600),
    user: { id: payload.user.id, email: payload.user.email ?? "" }
  };
}

export class CutTrackCloud {
  constructor() {
    this.session = readJSON(SESSION_KEY, null);
    this.listeners = new Set();
    this.syncing = false;
  }

  get user() { return this.session?.user ?? null; }
  get isSignedIn() { return Boolean(this.session?.access_token && this.session?.user?.id); }
  get outboxKey() { return `${OUTBOX_KEY}.${this.user?.id ?? "signed-out"}`; }
  get pendingCount() { return readJSON(this.outboxKey, []).length; }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(status, detail = "") {
    this.listeners.forEach(listener => listener({ status, detail, pending: this.pendingCount }));
  }

  saveSession(payload) {
    this.session = compactSession(payload);
    if (this.session) localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    else localStorage.removeItem(SESSION_KEY);
  }

  async authRequest(path, body) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.msg ?? payload.message ?? payload.error_description ?? "No se pudo iniciar sesión");
    return payload;
  }

  async signUp(email, password) {
    const payload = await this.authRequest("signup", { email, password });
    if (payload.access_token) this.saveSession(payload);
    return { signedIn: this.isSignedIn, confirmationRequired: !payload.access_token };
  }

  async signIn(email, password) {
    const payload = await this.authRequest("token?grant_type=password", { email, password });
    this.saveSession(payload);
    this.emit("online", "Sesión iniciada");
    return this.session;
  }

  async refreshSession() {
    if (!this.session?.refresh_token) throw new Error("Sesión cerrada");
    try {
      const payload = await this.authRequest("token?grant_type=refresh_token", { refresh_token: this.session.refresh_token });
      this.saveSession(payload);
      return this.session;
    } catch (error) {
      this.saveSession(null);
      this.emit("signed-out", error.message);
      throw error;
    }
  }

  async ensureSession() {
    if (!this.isSignedIn) throw new Error("Inicia sesión para sincronizar");
    if (Number(this.session.expires_at ?? 0) <= Math.floor(Date.now() / 1000) + 60) await this.refreshSession();
    return this.session;
  }

  async signOut() {
    if (this.session?.access_token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${this.session.access_token}` }
      }).catch(() => {});
    }
    this.saveSession(null);
    this.emit("signed-out", "Sesión cerrada");
  }

  async rest(path, { method = "GET", body, prefer } = {}) {
    await this.ensureSession();
    const headers = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${this.session.access_token}`,
      "Content-Type": "application/json"
    };
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message ?? payload?.hint ?? `Error de sincronización ${response.status}`);
    return payload;
  }

  async functionRequest(name, body) {
    await this.ensureSession();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${this.session.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? payload.message ?? "No se pudo completar la operación");
    return payload;
  }

  async analyzeFood({ text = "", imageBase64 = "", mimeType = "image/jpeg" }) {
    return this.functionRequest("analyze-food", {
      text,
      image_base64: imageBase64,
      mime_type: mimeType,
      local_time: new Date().toISOString()
    });
  }

  async healthIntegration(action = "status") {
    return this.functionRequest("health-import", { action });
  }

  async hevyIntegration(action = "status", apiKey = "") {
    return this.functionRequest("hevy-sync", {
      action,
      ...(apiKey ? { api_key: apiKey } : {})
    });
  }

  async uploadFoodImage(blob, foodID) {
    await this.ensureSession();
    const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
    const path = `${this.user.id}/${foodID}.${extension}`;
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/food-images/${path}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${this.session.access_token}`,
        "Content-Type": blob.type || "image/jpeg",
        "x-upsert": "true"
      },
      body: blob
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message ?? "No se pudo guardar la foto");
    }
    return path;
  }

  async deleteFoodImage(path) {
    await this.ensureSession();
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/food-images/${path}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${this.session.access_token}`
      }
    });
    if (!response.ok && response.status !== 404) throw new Error("No se pudo borrar la foto");
  }

  async foodImageURL(path) {
    if (!path) return null;
    await this.ensureSession();
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/food-images/${path}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${this.session.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 600 })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.signedURL) return null;
    return `${SUPABASE_URL}/storage/v1${payload.signedURL}`;
  }

  profileRow(settings) {
    return {
      user_id: this.user.id,
      calorie_target: settings.calorieTarget,
      protein_target: settings.proteinTarget,
      tdee_estimate: settings.tdeeEstimate,
      main_body_fat_target: settings.mainBodyFatTarget,
      starting_weight: settings.currentWeight,
      starting_body_fat: settings.currentBodyFat
    };
  }

  nutritionRow(entry) {
    return {
      user_id: this.user.id,
      day: entry.date,
      calories: entry.calories,
      protein: entry.protein,
      manual_weight: entry.weight,
      manual_body_fat: entry.bodyFat,
      manual_active_energy: entry.activeEnergy,
      manual_basal_energy: entry.basalEnergy,
      manual_steps: entry.steps,
      manual_sleep_hours: entry.sleep,
      client_updated_at: new Date().toISOString(),
      deleted_at: null
    };
  }

  enqueue(type, payload) {
    const outbox = readJSON(this.outboxKey, []);
    const key = type === "entry-upsert" || type === "entry-delete"
      ? `entry:${payload.date ?? payload}`
      : type === "food-upsert" || type === "food-delete"
        ? `food:${payload.id ?? payload}`
        : type;
    const filtered = outbox.filter(operation => operation.key !== key);
    filtered.push({ id: crypto.randomUUID(), key, type, payload, queuedAt: new Date().toISOString() });
    localStorage.setItem(this.outboxKey, JSON.stringify(filtered));
    this.emit("pending", "Guardado en este dispositivo");
  }

  async perform(type, payload) {
    if (type === "profile-upsert") {
      return this.rest("profiles?on_conflict=user_id", { method: "POST", body: this.profileRow(payload), prefer: "resolution=merge-duplicates,return=minimal" });
    }
    if (type === "entry-upsert") {
      return this.rest("nutrition_days?on_conflict=user_id,day", { method: "POST", body: this.nutritionRow(payload), prefer: "resolution=merge-duplicates,return=minimal" });
    }
    if (type === "entry-delete") {
      return this.rest("nutrition_days?on_conflict=user_id,day", {
        method: "POST",
        body: {
          user_id: this.user.id,
          day: payload,
          calories: null,
          protein: null,
          manual_weight: null,
          manual_body_fat: null,
          manual_active_energy: null,
          manual_basal_energy: null,
          manual_steps: null,
          manual_sleep_hours: null,
          client_updated_at: new Date().toISOString(),
          deleted_at: new Date().toISOString()
        },
        prefer: "resolution=merge-duplicates,return=minimal"
      });
    }
    if (type === "food-upsert") {
      return this.rest("rpc/save_food_entry", { method: "POST", body: { p_entry: {
        id: payload.id,
        consumed_at: payload.consumedAt,
        meal: payload.meal,
        name: payload.name,
        amount_description: payload.amountDescription,
        calories: payload.calories,
        protein: payload.protein,
        carbohydrates: payload.carbohydrates,
        fat: payload.fat,
        confidence: payload.confidence,
        source: payload.source,
        input_text: payload.inputText,
        image_path: payload.imagePath,
        assumptions: payload.assumptions ?? [],
        items: payload.items ?? [],
        calories_low: payload.caloriesLow ?? payload.calories,
        calories_high: payload.caloriesHigh ?? payload.calories,
        reference_object: payload.referenceObject ?? {},
        client_updated_at: payload.clientUpdatedAt ?? new Date().toISOString()
      } } });
    }
    if (type === "food-delete") {
      return this.rest("rpc/delete_food_entry", { method: "POST", body: { p_id: payload.id ?? payload } });
    }
    throw new Error("Operación desconocida");
  }

  async mutate(type, payload) {
    try {
      await this.perform(type, payload);
      this.emit("online", "Sincronizado");
      return true;
    } catch (error) {
      this.enqueue(type, payload);
      return false;
    }
  }

  async flushOutbox() {
    const key = this.outboxKey;
    const outbox = readJSON(key, []);
    if (!outbox.length) return;
    const remaining = [];
    for (const operation of outbox) {
      try {
        await this.perform(operation.type, operation.payload);
      } catch {
        remaining.push(operation);
      }
    }
    localStorage.setItem(key, JSON.stringify(remaining));
    if (remaining.length) throw new Error(`${remaining.length} cambios siguen pendientes`);
  }

  async fetchRemoteState(defaultState) {
    const [profiles, nutrition, health, workouts, foods] = await Promise.all([
      this.rest(`profiles?user_id=eq.${this.user.id}&select=*`),
      this.rest(`nutrition_days?user_id=eq.${this.user.id}&select=*&order=day.asc`),
      this.rest(`health_days?user_id=eq.${this.user.id}&select=*&order=day.asc`),
      this.rest(`workouts?user_id=eq.${this.user.id}&select=*&order=started_at.desc`),
      this.rest(`food_entries?user_id=eq.${this.user.id}&deleted_at=is.null&select=*&order=consumed_at.desc`)
    ]);
    const profile = profiles?.[0] ?? null;
    const byDay = new Map();
    for (const row of nutrition ?? []) {
      if (row.deleted_at) continue;
      byDay.set(row.day, {
        date: row.day,
        calories: row.calories,
        protein: row.protein,
        weight: row.manual_weight,
        bodyFat: row.manual_body_fat,
        activeEnergy: row.manual_active_energy,
        basalEnergy: row.manual_basal_energy,
        steps: row.manual_steps,
        sleep: row.manual_sleep_hours
      });
    }
    for (const row of health ?? []) {
      const entry = byDay.get(row.day) ?? { date: row.day };
      byDay.set(row.day, {
        ...entry,
        weight: row.weight ?? entry.weight ?? null,
        bodyFat: row.body_fat ?? entry.bodyFat ?? null,
        activeEnergy: row.active_energy ?? entry.activeEnergy ?? null,
        basalEnergy: row.basal_energy ?? entry.basalEnergy ?? null,
        steps: row.steps ?? entry.steps ?? null,
        sleep: row.sleep_hours ?? entry.sleep ?? null,
        restingHeartRate: row.resting_heart_rate ?? null,
        healthUpdatedAt: row.health_updated_at
      });
    }
    return {
      ...structuredClone(defaultState),
      configured: Boolean(profile),
      settings: profile ? {
        calorieTarget: profile.calorie_target,
        proteinTarget: profile.protein_target,
        tdeeEstimate: profile.tdee_estimate,
        mainBodyFatTarget: Number(profile.main_body_fat_target),
        currentWeight: profile.starting_weight === null ? null : Number(profile.starting_weight),
        currentBodyFat: profile.starting_body_fat === null ? null : Number(profile.starting_body_fat)
      } : structuredClone(defaultState.settings),
      entries: [...byDay.values()],
      foods: (foods ?? []).map(row => ({
        id: row.id,
        consumedAt: row.consumed_at,
        meal: row.meal,
        name: row.name,
        amountDescription: row.amount_description,
        calories: Number(row.calories),
        protein: Number(row.protein),
        carbohydrates: Number(row.carbohydrates),
        fat: Number(row.fat),
        confidence: row.confidence === null ? null : Number(row.confidence),
        source: row.source,
        inputText: row.input_text,
        imagePath: row.image_path,
        assumptions: row.assumptions ?? [],
        items: row.items ?? [],
        caloriesLow: row.calories_low === null ? Number(row.calories) : Number(row.calories_low),
        caloriesHigh: row.calories_high === null ? Number(row.calories) : Number(row.calories_high),
        referenceObject: row.reference_object ?? {},
        clientUpdatedAt: row.client_updated_at
      })),
      workouts: (workouts ?? []).map(row => row.payload && Object.keys(row.payload).length ? row.payload : ({
        id: row.source_id, title: row.title, start_time: row.started_at, end_time: row.ended_at, exercises: []
      }))
    };
  }

  async sync(localState, defaultState) {
    if (this.syncing) return null;
    this.syncing = true;
    this.emit("syncing", "Sincronizando");
    try {
      await this.ensureSession();
      await this.flushOutbox();
      let remote = await this.fetchRemoteState(defaultState);
      if (!remote.configured && localState.configured) {
        await this.perform("profile-upsert", localState.settings);
        for (const entry of localState.entries) await this.perform("entry-upsert", entry);
        for (const food of localState.foods ?? []) await this.perform("food-upsert", food);
        remote = await this.fetchRemoteState(defaultState);
      }
      this.emit("online", "Todo sincronizado");
      return remote;
    } catch (error) {
      this.emit(navigator.onLine ? "error" : "offline", error.message);
      throw error;
    } finally {
      this.syncing = false;
    }
  }
}

export const cloud = new CutTrackCloud();
