import { parseHealthExport } from "../_shared/health-auto-export.ts";

const allowedOrigins = new Set([
  "https://cuttrack.pages.dev",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

function headers(origin = null) {
  const output = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.has(origin)) output["Access-Control-Allow-Origin"] = origin;
  output["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-api-key";
  output["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  return output;
}

function respond(body, status = 200, origin = null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

function bytesToBase64URL(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serviceHeaders(serviceKey, prefer = "") {
  const output = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  if (prefer) output.Prefer = prefer;
  return output;
}

async function serviceRequest(supabaseURL, serviceKey, path, options = {}) {
  const response = await fetch(`${supabaseURL}/rest/v1/${path}`, {
    method: options.method ?? "GET",
    headers: serviceHeaders(serviceKey, options.prefer),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? `database error ${response.status}`);
  return payload;
}

async function authenticatedUser(request, supabaseURL, publishableKey) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const response = await fetch(`${supabaseURL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: publishableKey },
  });
  return response.ok ? response.json() : null;
}

async function manageIntegration(request, body, env, origin) {
  if (origin && !allowedOrigins.has(origin)) return respond({ error: "origin not allowed" }, 403, origin);
  const user = await authenticatedUser(request, env.supabaseURL, env.publishableKey);
  if (!user?.id) return respond({ error: "authentication required" }, 401, origin);
  const action = String(body?.action ?? "status");
  const filter = `integration_secrets?user_id=eq.${encodeURIComponent(user.id)}&provider=eq.health_auto_export`;

  if (action === "create") {
    const token = bytesToBase64URL(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256(token);
    await serviceRequest(env.supabaseURL, env.serviceKey, "integration_secrets?on_conflict=user_id,provider", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        user_id: user.id,
        provider: "health_auto_export",
        token_hash: tokenHash,
        encrypted_secret: null,
        secret_iv: null,
        status: "connected",
        last_sync_at: null,
        last_error: null,
        metadata: { configured_by: "pwa" },
      },
    });
    return respond({
      token,
      endpoint: `${env.supabaseURL}/functions/v1/health-import`,
      connected: true,
      last_sync_at: null,
    }, 200, origin);
  }

  if (action === "revoke") {
    await serviceRequest(env.supabaseURL, env.serviceKey, filter, { method: "DELETE" });
    return respond({ connected: false, last_sync_at: null }, 200, origin);
  }

  const rows = await serviceRequest(
    env.supabaseURL,
    env.serviceKey,
    `${filter}&select=status,last_sync_at,last_error`,
  );
  const integration = rows?.[0] ?? null;
  return respond({
    connected: integration?.status === "connected",
    last_sync_at: integration?.last_sync_at ?? null,
    last_error: integration?.last_error ?? null,
  }, 200, origin);
}

async function mergeHealthDays(env, userID, incoming) {
  if (!incoming.length) return 0;
  const dates = incoming.map((row) => row.day).join(",");
  const existing = await serviceRequest(
    env.supabaseURL,
    env.serviceKey,
    `health_days?user_id=eq.${encodeURIComponent(userID)}&day=in.(${dates})&select=*`,
  );
  const byDay = new Map((existing ?? []).map((row) => [row.day, row]));
  const rows = incoming.map((row) => {
    const previous = byDay.get(row.day) ?? {};
    return {
      user_id: userID,
      day: row.day,
      weight: row.weight ?? previous.weight ?? null,
      body_fat: row.body_fat ?? previous.body_fat ?? null,
      active_energy: row.active_energy ?? previous.active_energy ?? null,
      basal_energy: row.basal_energy ?? previous.basal_energy ?? null,
      steps: row.steps === undefined ? previous.steps ?? null : Math.round(row.steps),
      sleep_hours: row.sleep_hours ?? previous.sleep_hours ?? null,
      resting_heart_rate: row.resting_heart_rate ?? previous.resting_heart_rate ?? null,
      health_updated_at: row.health_updated_at,
      device_id: previous.device_id ?? null,
      source: row.source,
    };
  });
  await serviceRequest(env.supabaseURL, env.serviceKey, "health_days?on_conflict=user_id,day", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
  });
  return rows.length;
}

async function saveWorkouts(env, userID, incoming) {
  if (!incoming.length) return 0;
  const rows = incoming.map((row) => ({
    user_id: userID,
    source: "health_auto_export",
    source_id: row.source_id,
    title: row.title,
    started_at: row.started_at,
    ended_at: row.ended_at,
    payload: row.payload,
    client_updated_at: row.client_updated_at,
    device_id: null,
  }));
  await serviceRequest(env.supabaseURL, env.serviceKey, "workouts?on_conflict=user_id,source,source_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
  });
  return rows.length;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return respond({ error: "method not allowed" }, 405, origin);

  const env = {
    supabaseURL: Deno.env.get("SUPABASE_URL"),
    publishableKey: Deno.env.get("SUPABASE_ANON_KEY"),
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  };
  if (!env.supabaseURL || !env.publishableKey || !env.serviceKey) {
    return respond({ error: "service unavailable" }, 503, origin);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_000_000) return respond({ error: "payload too large" }, 413, origin);
  const raw = await request.text();
  if (raw.length > 2_000_000) return respond({ error: "payload too large" }, 413, origin);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return respond({ error: "invalid JSON" }, 400, origin);
  }

  if (request.headers.get("authorization")) return manageIntegration(request, body, env, origin);

  const token = String(request.headers.get("x-api-key") ?? "").trim();
  if (token.length < 32) return respond({ error: "authentication required" }, 401, origin);
  const tokenHash = await sha256(token);
  let integrations;
  try {
    integrations = await serviceRequest(
      env.supabaseURL,
      env.serviceKey,
      `integration_secrets?provider=eq.health_auto_export&token_hash=eq.${tokenHash}&status=eq.connected&select=user_id`,
    );
  } catch (error) {
    console.error("Health token lookup failed", error);
    return respond({ error: "token lookup failed" }, 500, origin);
  }
  const integration = integrations?.[0];
  if (!integration?.user_id) return respond({ error: "invalid token" }, 401, origin);

  try {
    const parsed = parseHealthExport(body);
    const healthDays = await mergeHealthDays(env, integration.user_id, parsed.healthDays);
    const workouts = await saveWorkouts(env, integration.user_id, parsed.workouts);
    await serviceRequest(
      env.supabaseURL,
      env.serviceKey,
      `integration_secrets?user_id=eq.${encodeURIComponent(integration.user_id)}&provider=eq.health_auto_export`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "connected", last_sync_at: new Date().toISOString(), last_error: null },
      },
    );
    return respond({ ok: true, health_days: healthDays, workouts }, 200, origin);
  } catch (error) {
    console.error("Health import failed", error);
    await serviceRequest(
      env.supabaseURL,
      env.serviceKey,
      `integration_secrets?user_id=eq.${encodeURIComponent(integration.user_id)}&provider=eq.health_auto_export`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "error", last_error: String(error?.message ?? error).slice(0, 500) },
      },
    ).catch(() => {});
    return respond({ error: "health import failed" }, 500, origin);
  }
});
