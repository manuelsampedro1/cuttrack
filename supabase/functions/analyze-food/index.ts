const allowedOrigins = new Set([
  "https://cuttrack.pages.dev",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

const schema = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    amount_description: { type: "STRING" },
    calories: { type: "NUMBER" },
    protein: { type: "NUMBER" },
    carbohydrates: { type: "NUMBER" },
    fat: { type: "NUMBER" },
    confidence: { type: "NUMBER" },
    meal: { type: "STRING", enum: ["breakfast", "lunch", "dinner", "snack"] },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: [
    "name",
    "amount_description",
    "calories",
    "protein",
    "carbohydrates",
    "fat",
    "confidence",
    "meal",
    "assumptions",
  ],
};

function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.has(origin) ? origin : "https://cuttrack.pages.dev";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

function response(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

function finite(value: unknown, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error("invalid nutrition value");
  return Math.round(number * 10) / 10;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response({ error: "method not allowed" }, 405, origin);
  if (origin && !allowedOrigins.has(origin)) return response({ error: "origin not allowed" }, 403, origin);

  const authorization = request.headers.get("authorization");
  const supabaseURL = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!authorization || !supabaseURL || !publishableKey || !geminiKey) {
    return response({ error: "service unavailable" }, 503, origin);
  }

  const userResponse = await fetch(`${supabaseURL}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: publishableKey },
  });
  if (!userResponse.ok) return response({ error: "authentication required" }, 401, origin);

  const quotaResponse = await fetch(`${supabaseURL}/rest/v1/rpc/consume_ai_request`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const quotaAllowed = quotaResponse.ok ? await quotaResponse.json() : false;
  if (quotaAllowed !== true) return response({ error: "Límite diario de análisis alcanzado" }, 429, origin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return response({ error: "invalid body" }, 400, origin);
  }

  const text = String(body.text ?? "").trim().slice(0, 1000);
  const imageBase64 = String(body.image_base64 ?? "");
  const mimeType = String(body.mime_type ?? "image/jpeg");
  const localTime = String(body.local_time ?? new Date().toISOString()).slice(0, 40);
  if (!text && !imageBase64) return response({ error: "write a food or attach a photo" }, 400, origin);
  if (imageBase64.length > 10_700_000) return response({ error: "image too large" }, 413, origin);
  if (imageBase64 && !/^image\/(jpeg|png|webp|heic|heif)$/.test(mimeType)) {
    return response({ error: "unsupported image" }, 415, origin);
  }

  const prompt = `
Eres el motor de registro nutricional de una app personal española. Analiza la foto y/o el texto del usuario y devuelve una sola estimación total para todo lo consumido.

Reglas:
- Interpreta lenguaje cotidiano, cantidades y marcas españolas. Por ejemplo, "tres tercios Amstel" significa 3 botellas de 330 ml de cerveza Amstel.
- Si hay varias unidades, multiplica calorías y macros por el número total.
- En fotos, estima el tamaño de cada porción visible. Incluye bebidas, salsas y aceite solo si son visibles o el texto los menciona.
- name debe ser corto pero describir todo el registro. amount_description debe dejar claras unidades y porciones.
- calories, protein, carbohydrates y fat son totales del registro, no por unidad.
- La energía del alcohol puede hacer que las calorías no coincidan con 4/4/9 de los macros.
- confidence va de 0 a 1. Usa 0.55 o menos si la cantidad no puede inferirse con razonable seguridad.
- assumptions contiene como máximo tres supuestos breves y útiles para corregir la estimación.
- meal se infiere con la hora local y el contenido: breakfast, lunch, dinner o snack.
- No des consejos médicos ni texto adicional.

Hora local: ${localTime}
Texto del usuario: ${text || "Sin texto, usa la imagen."}
`;

  const parts: Record<string, unknown>[] = [{ text: prompt }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
    },
  );

  if (!geminiResponse.ok) {
    const detail = (await geminiResponse.text()).slice(0, 300);
    console.error("Gemini error", geminiResponse.status, detail);
    return response({ error: "food analysis failed" }, 502, origin);
  }

  try {
    const payload = await geminiResponse.json();
    const raw = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(raw);
    const meal = ["breakfast", "lunch", "dinner", "snack"].includes(result.meal) ? result.meal : "snack";
    return response({
      name: String(result.name ?? "Registro de comida").trim().slice(0, 180),
      amount_description: String(result.amount_description ?? "").trim().slice(0, 500),
      calories: finite(result.calories, 0, 10000),
      protein: finite(result.protein, 0, 1000),
      carbohydrates: finite(result.carbohydrates, 0, 1000),
      fat: finite(result.fat, 0, 1000),
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
      meal,
      assumptions: Array.isArray(result.assumptions)
        ? result.assumptions.slice(0, 3).map((item: unknown) => String(item).slice(0, 180))
        : [],
    }, 200, origin);
  } catch (error) {
    console.error("Invalid Gemini response", error);
    return response({ error: "invalid analysis response" }, 502, origin);
  }
});
