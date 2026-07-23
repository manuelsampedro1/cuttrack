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
    calories_low: { type: "NUMBER" },
    calories_high: { type: "NUMBER" },
    confidence: { type: "NUMBER" },
    meal: { type: "STRING", enum: ["breakfast", "lunch", "dinner", "snack"] },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
    reference_object: {
      type: "OBJECT",
      properties: {
        detected: { type: "BOOLEAN" },
        object: { type: "STRING" },
        assumed_width_mm: { type: "NUMBER" },
        assumed_height_mm: { type: "NUMBER" },
        confidence: { type: "NUMBER" },
        same_plane: { type: "BOOLEAN" },
        image_index: { type: "INTEGER" },
      },
      required: ["detected", "object", "assumed_width_mm", "assumed_height_mm", "confidence", "same_plane", "image_index"],
    },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          estimated_weight_g: { type: "NUMBER" },
          calories: { type: "NUMBER" },
          calories_low: { type: "NUMBER" },
          calories_high: { type: "NUMBER" },
          protein: { type: "NUMBER" },
          carbohydrates: { type: "NUMBER" },
          fat: { type: "NUMBER" },
          confidence: { type: "NUMBER" },
          portion_basis: { type: "STRING" },
          box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
          image_index: { type: "INTEGER" },
        },
        required: [
          "name",
          "estimated_weight_g",
          "calories",
          "calories_low",
          "calories_high",
          "protein",
          "carbohydrates",
          "fat",
          "confidence",
          "portion_basis",
          "box_2d",
          "image_index",
        ],
      },
    },
  },
  required: [
    "name",
    "amount_description",
    "calories",
    "protein",
    "carbohydrates",
    "fat",
    "calories_low",
    "calories_high",
    "confidence",
    "meal",
    "assumptions",
    "reference_object",
    "items",
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

function normalizedBox(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return [];
  const output = value.map((item) => Math.round(Number(item)));
  if (output.some((item) => !Number.isFinite(item) || item < 0 || item > 1000)) return [];
  if (output[2] <= output[0] || output[3] <= output[1]) return [];
  return output;
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
  const legacyImage = String(body.image_base64 ?? "");
  const inputImages = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
  const images = inputImages.map((image: Record<string, unknown>) => ({
    data: String(image?.base64 ?? image?.data ?? ""),
    mimeType: String(image?.mime_type ?? image?.mimeType ?? "image/jpeg"),
  })).filter((image) => image.data);
  if (!images.length && legacyImage) images.push({ data: legacyImage, mimeType: String(body.mime_type ?? "image/jpeg") });
  const localTime = String(body.local_time ?? new Date().toISOString()).slice(0, 40);
  if (!text && !images.length) return response({ error: "write a food or attach a photo" }, 400, origin);
  if (images.reduce((total, image) => total + image.data.length, 0) > 16_000_000) return response({ error: "images too large" }, 413, origin);
  if (images.some((image) => !/^image\/(jpeg|png|webp|heic|heif)$/.test(image.mimeType))) {
    return response({ error: "unsupported image" }, 415, origin);
  }

  const prompt = `
Eres el motor de visión y registro nutricional de una app personal española. Tu trabajo es separar cada alimento o bebida, estimar su porción y devolver un plato editable.

Reglas:
- Interpreta lenguaje cotidiano, cantidades y marcas españolas. Por ejemplo, "tres tercios Amstel" significa 3 botellas de 330 ml de cerveza Amstel.
- Si hay varias unidades, multiplica calorías y macros por el número total.
- En fotos, crea un elemento por cada componente comestible distinguible. Separa guarniciones, salsas, aceite, bebidas y unidades repetidas cuando afecte a la corrección.
- Puede haber hasta dos imágenes del mismo consumo. La segunda es otro ángulo o una etiqueta. Úsalas juntas para reducir incertidumbre y nunca cuentes dos veces el mismo alimento.
- Si una imagen muestra una etiqueta nutricional legible, prioriza sus valores exactos y escala por la cantidad consumida.
- box_2d es la región visible de ese componente como [ymin, xmin, ymax, xmax], normalizada de 0 a 1000. image_index indica la imagen donde esa región se ve mejor, empezando por 0. Si solo hay texto, usa [0, 0, 0, 0] e image_index 0.
- estimated_weight_g es el peso comestible total del componente, no el peso del recipiente. Estima volumen, densidad y parte oculta con prudencia.
- Busca un objeto de escala conocido, como una carcasa de AirPods, una tarjeta o un cubierto. No lo incluyas como alimento. Solo úsalo para escala si su tipo es razonablemente identificable y está aproximadamente en el mismo plano que la comida.
- Las carcasas de AirPods varían según el modelo. Si no identificas el modelo exacto, usa dimensiones aproximadas, baja reference_object.confidence y explícalo en assumptions.
- reference_object.image_index indica la imagen donde la referencia se midió mejor.
- Un objeto de referencia mejora la escala en el plano, pero no revela por sí solo el grosor, densidad, relleno, aceite absorbido ni comida oculta. Refleja esa incertidumbre en confidence y en el rango calórico.
- Incluye aceite y salsas solo si son visibles, los menciona el usuario o son muy probables por la preparación. Cuando sean probables pero no demostrables, indícalo como supuesto.
- portion_basis explica brevemente de dónde sale el peso: referencia visual, unidad conocida, etiqueta, tamaño del plato o densidad habitual.
- name debe ser corto pero describir todo el registro. amount_description debe dejar claras unidades y porciones.
- calories, protein, carbohydrates y fat de arriba son la suma exacta de items.
- calories_low y calories_high forman un rango plausible para todo el registro. El valor calories seleccionado debe quedar aproximadamente en el percentil 65 del rango, con un sesgo superior pequeño para evitar infravalorar, nunca en el máximo salvo evidencia clara.
- Cada item incluye calories_low, calories_high y el valor calories elegido aproximadamente en el percentil 65 de su propio rango. No infles porciones arbitrariamente y no inventes alimentos que no se vean ni se mencionen.
- La energía del alcohol puede hacer que las calorías no coincidan con 4/4/9 de los macros.
- confidence va de 0 a 1. Usa 0.55 o menos si la cantidad no puede inferirse con razonable seguridad. Cada item tiene su propia confianza.
- assumptions contiene como máximo cinco supuestos breves y útiles para corregir la estimación.
- meal se infiere con la hora local y el contenido: breakfast, lunch, dinner o snack.
- No des consejos médicos ni texto adicional.

Hora local: ${localTime}
Texto del usuario: ${text || "Sin texto, usa la imagen."}
`;

  const parts: Record<string, unknown>[] = [{ text: `${prompt}\nNúmero de imágenes: ${images.length}.` }];
  images.forEach((image, index) => {
    parts.push({ text: `Imagen ${index + 1} del mismo consumo:` });
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  });

  let geminiResponse: Response | null = null;
  for (const model of ["gemini-3.5-flash", "gemini-2.5-flash"]) {
    geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`,
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
    if (geminiResponse.ok || geminiResponse.status !== 404) break;
  }

  if (!geminiResponse?.ok) {
    const detail = geminiResponse ? (await geminiResponse.text()).slice(0, 300) : "no response";
    console.error("Gemini error", geminiResponse.status, detail);
    return response({ error: "food analysis failed" }, 502, origin);
  }

  try {
    const payload = await geminiResponse.json();
    const raw = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(raw);
    const items = (Array.isArray(result.items) ? result.items : []).slice(0, 30).map((item: Record<string, unknown>) => ({
      name: String(item.name ?? "Alimento").trim().slice(0, 120),
      estimated_weight_g: finite(item.estimated_weight_g, 0, 5000),
      calories: finite(item.calories, 0, 10000),
      calories_low: finite(item.calories_low, 0, 10000),
      calories_high: finite(item.calories_high, 0, 10000),
      protein: finite(item.protein, 0, 1000),
      carbohydrates: finite(item.carbohydrates, 0, 1000),
      fat: finite(item.fat, 0, 1000),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      portion_basis: String(item.portion_basis ?? "Estimación visual").trim().slice(0, 180),
      box_2d: normalizedBox(item.box_2d),
      image_index: Math.max(0, Math.min(images.length - 1, Math.round(Number(item.image_index) || 0))),
    }));
    if (!items.length) throw new Error("analysis returned no items");
    for (const item of items) {
      item.calories_low = Math.min(Number(item.calories_low), Number(item.calories));
      item.calories_high = Math.max(Number(item.calories_high), Number(item.calories));
    }
    const totals = items.reduce((sum: Record<string, number>, item: Record<string, unknown>) => ({
      calories: sum.calories + Number(item.calories),
      protein: sum.protein + Number(item.protein),
      carbohydrates: sum.carbohydrates + Number(item.carbohydrates),
      fat: sum.fat + Number(item.fat),
    }), { calories: 0, protein: 0, carbohydrates: 0, fat: 0 });
    const meal = ["breakfast", "lunch", "dinner", "snack"].includes(result.meal) ? result.meal : "snack";
    const caloriesLow = Math.min(totals.calories, finite(result.calories_low, 0, 10000));
    const caloriesHigh = Math.max(totals.calories, finite(result.calories_high, 0, 10000));
    const referenceObject = result.reference_object ?? {};
    return response({
      name: String(result.name ?? "Registro de comida").trim().slice(0, 180),
      amount_description: String(result.amount_description ?? "").trim().slice(0, 500),
      calories: Math.round(totals.calories * 10) / 10,
      protein: Math.round(totals.protein * 10) / 10,
      carbohydrates: Math.round(totals.carbohydrates * 10) / 10,
      fat: Math.round(totals.fat * 10) / 10,
      calories_low: caloriesLow,
      calories_high: caloriesHigh,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
      meal,
      assumptions: Array.isArray(result.assumptions)
        ? result.assumptions.slice(0, 5).map((item: unknown) => String(item).slice(0, 180))
        : [],
      reference_object: {
        detected: Boolean(referenceObject.detected),
        object: String(referenceObject.object ?? "").trim().slice(0, 120),
        assumed_width_mm: finite(referenceObject.assumed_width_mm ?? 0, 0, 1000),
        assumed_height_mm: finite(referenceObject.assumed_height_mm ?? 0, 0, 1000),
        confidence: Math.max(0, Math.min(1, Number(referenceObject.confidence) || 0)),
        same_plane: Boolean(referenceObject.same_plane),
        image_index: Math.max(0, Math.min(images.length - 1, Math.round(Number(referenceObject.image_index) || 0))),
      },
      items,
    }, 200, origin);
  } catch (error) {
    console.error("Invalid Gemini response", error);
    return response({ error: "invalid analysis response" }, 502, origin);
  }
});
