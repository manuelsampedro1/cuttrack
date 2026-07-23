import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

globalThis.localStorage = new MemoryStorage();
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const { CutTrackCloud } = await import("../cloud.js");

const userID = "11111111-1111-4111-8111-111111111111";
const authPayload = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  user: { id: userID, email: "test@example.com" }
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("Apple Salud prevalece sobre el dato manual del mismo día", async () => {
  localStorage.clear();
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes("/auth/v1/token")) return jsonResponse(authPayload);
    if (value.includes("/profiles")) return jsonResponse([{ user_id: userID, calorie_target: 1900, protein_target: 180, tdee_estimate: 2600, main_body_fat_target: 15, starting_weight: 82, starting_body_fat: 20 }]);
    if (value.includes("/nutrition_days")) return jsonResponse([{ day: "2026-07-23", calories: 1800, protein: 175, manual_weight: 82.5, manual_steps: 5000 }]);
    if (value.includes("/health_days")) return jsonResponse([{ day: "2026-07-23", weight: 81.9, steps: 9200, health_updated_at: "2026-07-23T12:00:00Z" }]);
    if (value.includes("/workouts")) return jsonResponse([]);
    if (value.includes("/food_entries")) return jsonResponse([]);
    throw new Error(`URL inesperada: ${value}`);
  };
  const client = new CutTrackCloud();
  await client.signIn("test@example.com", "password123");
  const defaults = { version: 1, configured: false, settings: {}, entries: [], foods: [], workouts: [] };
  const state = await client.fetchRemoteState(defaults);
  assert.equal(state.entries[0].weight, 81.9);
  assert.equal(state.entries[0].steps, 9200);
  assert.equal(state.entries[0].calories, 1800);
});

test("un fallo de red deja el cambio en la cola local", async () => {
  localStorage.clear();
  globalThis.fetch = async url => {
    if (String(url).includes("/auth/v1/token")) return jsonResponse(authPayload);
    throw new Error("offline");
  };
  const client = new CutTrackCloud();
  await client.signIn("test@example.com", "password123");
  const synced = await client.mutate("entry-upsert", { date: "2026-07-23", calories: 1800 });
  assert.equal(synced, false);
  assert.equal(client.pendingCount, 1);
});

test("la cola offline queda separada por cuenta", () => {
  localStorage.clear();
  const client = new CutTrackCloud();
  client.saveSession(authPayload);
  client.enqueue("entry-upsert", { date: "2026-07-23", calories: 1800 });
  assert.equal(client.pendingCount, 1);

  client.saveSession({
    ...authPayload,
    user: { id: "22222222-2222-4222-8222-222222222222", email: "other@example.com" }
  });
  assert.equal(client.pendingCount, 0);

  client.saveSession(authPayload);
  assert.equal(client.pendingCount, 1);
});
