import { normalizeHevyWorkouts } from "../_shared/hevy.ts";

const allowedOrigins = new Set([
  "https://cuttrack.pages.dev",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

function responseHeaders(origin = null) {
  const output = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.has(origin)) output["Access-Control-Allow-Origin"] = origin;
  return output;
}

function respond(body, status = 200, origin = null) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptionKey(encoded) {
  const bytes = base64ToBytes(encoded);
  if (bytes.length !== 32) throw new Error("invalid encryption key");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(secret, encodedKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(encodedKey);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return { encrypted: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptSecret(encrypted, iv, encodedKey) {
  const key = await encryptionKey(encodedKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(encrypted),
  );
  return new TextDecoder().decode(plain);
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

async function serviceRequest(env, path, options = {}) {
  const response = await fetch(`${env.supabaseURL}/rest/v1/${path}`, {
    method: options.method ?? "GET",
    headers: serviceHeaders(env.serviceKey, options.prefer),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? `database error ${response.status}`);
  return payload;
}

async function authenticatedUser(request, env) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const response = await fetch(`${env.supabaseURL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: env.publishableKey },
  });
  return response.ok ? response.json() : null;
}

async function hevyRequest(apiKey, path) {
  const response = await fetch(`https://api.hevyapp.com${path}`, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "La clave de Hevy no es válida" : `Hevy respondió ${response.status}`);
  return payload;
}

async function setError(env, userID, error) {
  await serviceRequest(env, `integration_secrets?user_id=eq.${encodeURIComponent(userID)}&provider=eq.hevy`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status: "error", last_error: String(error?.message ?? error).slice(0, 500) },
  }).catch(() => {});
}

async function syncOne(env, integration, maximumPages = 1) {
  try {
    const apiKey = await decryptSecret(integration.encrypted_secret, integration.secret_iv, env.encryptionKey);
    let page = 1;
    let pageCount = 1;
    const workouts = [];
    do {
      const payload = await hevyRequest(apiKey, `/v1/workouts?page=${page}&pageSize=10`);
      workouts.push(...normalizeHevyWorkouts(payload));
      pageCount = Math.max(1, Number(payload?.page_count ?? 1));
      page += 1;
    } while (page <= Math.min(pageCount, maximumPages));

    const rows = workouts.map((workout) => ({
      user_id: integration.user_id,
      source: "hevy",
      source_id: workout.source_id,
      title: workout.title,
      started_at: workout.started_at,
      ended_at: workout.ended_at,
      payload: workout.payload,
      client_updated_at: workout.client_updated_at,
      device_id: null,
    }));
    if (rows.length) {
      await serviceRequest(env, "workouts?on_conflict=user_id,source,source_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: rows,
      });
    }
    const syncedAt = new Date().toISOString();
    await serviceRequest(env, `integration_secrets?user_id=eq.${encodeURIComponent(integration.user_id)}&provider=eq.hevy`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "connected", last_sync_at: syncedAt, last_error: null },
    });
    return { workouts: rows.length, last_sync_at: syncedAt };
  } catch (error) {
    await setError(env, integration.user_id, error);
    throw error;
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (request.method !== "POST") return respond({ error: "method not allowed" }, 405, origin);
  if (origin && !allowedOrigins.has(origin)) return respond({ error: "origin not allowed" }, 403, origin);

  const env = {
    supabaseURL: Deno.env.get("SUPABASE_URL"),
    publishableKey: Deno.env.get("SUPABASE_ANON_KEY"),
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    encryptionKey: Deno.env.get("INTEGRATION_ENCRYPTION_KEY"),
    cronSecret: Deno.env.get("HEVY_CRON_SECRET"),
  };
  if (Object.values(env).some((value) => !value)) return respond({ error: "service unavailable" }, 503, origin);

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const action = String(body?.action ?? "status");

  if (action === "cron") {
    if (!env.cronSecret || request.headers.get("x-cron-secret") !== env.cronSecret) {
      return respond({ error: "authentication required" }, 401, origin);
    }
    const integrations = await serviceRequest(
      env,
      "integration_secrets?provider=eq.hevy&status=in.(connected,error)&select=user_id,encrypted_secret,secret_iv",
    );
    let synced = 0;
    let failed = 0;
    for (const integration of integrations ?? []) {
      try {
        await syncOne(env, integration, 1);
        synced += 1;
      } catch {
        failed += 1;
      }
    }
    return respond({ ok: true, synced, failed }, 200, origin);
  }

  const user = await authenticatedUser(request, env);
  if (!user?.id) return respond({ error: "authentication required" }, 401, origin);
  const filter = `integration_secrets?user_id=eq.${encodeURIComponent(user.id)}&provider=eq.hevy`;

  if (action === "connect") {
    const apiKey = String(body?.api_key ?? "").trim();
    if (apiKey.length < 12 || apiKey.length > 500) return respond({ error: "Introduce una clave válida de Hevy" }, 400, origin);
    try {
      const userInfo = await hevyRequest(apiKey, "/v1/user/info");
      const secret = await encryptSecret(apiKey, env.encryptionKey);
      await serviceRequest(env, "integration_secrets?on_conflict=user_id,provider", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          user_id: user.id,
          provider: "hevy",
          token_hash: null,
          encrypted_secret: secret.encrypted,
          secret_iv: secret.iv,
          status: "connected",
          last_sync_at: null,
          last_error: null,
          metadata: { connected: true, account: String(userInfo?.username ?? userInfo?.name ?? "").slice(0, 100) },
        },
      });
      const integration = { user_id: user.id, encrypted_secret: secret.encrypted, secret_iv: secret.iv };
      const result = await syncOne(env, integration, 3);
      return respond({ connected: true, ...result }, 200, origin);
    } catch (error) {
      return respond({ error: String(error?.message ?? error) }, 400, origin);
    }
  }

  if (action === "disconnect") {
    await serviceRequest(env, filter, { method: "DELETE" });
    return respond({ connected: false, last_sync_at: null }, 200, origin);
  }

  const integrations = await serviceRequest(
    env,
    `${filter}&select=user_id,encrypted_secret,secret_iv,status,last_sync_at,last_error`,
  );
  const integration = integrations?.[0] ?? null;
  if (action === "sync") {
    if (!integration) return respond({ error: "Conecta Hevy primero" }, 400, origin);
    try {
      const result = await syncOne(env, integration, 3);
      return respond({ connected: true, ...result }, 200, origin);
    } catch (error) {
      return respond({ error: String(error?.message ?? error) }, 502, origin);
    }
  }

  return respond({
    connected: Boolean(integration),
    status: integration?.status ?? "disconnected",
    last_sync_at: integration?.last_sync_at ?? null,
    last_error: integration?.last_error ?? null,
  }, 200, origin);
});
