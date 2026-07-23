# CutTrack PWA

PWA instalable y privada para estimar déficit energético, seguir proteína, peso, composición corporal y entrenamientos de Hevy.

Supabase guarda la cuenta, los ajustes, los registros diarios y la réplica de Apple Salud, Garmin y Hevy. El navegador mantiene una caché offline separada por usuario.

## Sincronización sin cable

- Apple Salud: Health Auto Export envía por REST resúmenes de peso, grasa corporal, pasos, sueño, energía activa, energía basal y frecuencia cardiaca en reposo.
- Garmin: Garmin Connect escribe sus métricas y actividades en Apple Salud. Health Auto Export usa la misma ruta de entrada de CutTrack.
- Hevy: una Edge Function valida la clave oficial, la cifra con AES-GCM y sincroniza entrenamientos cada treinta minutos mediante Supabase Cron.
- El webhook de Salud usa una clave aleatoria de escritura. En la base solo se guarda su hash y nunca permite leer el historial.
- La PWA genera un deep link que prepara Health Auto Export con endpoint, métricas, agregación diaria y frecuencia. iOS sigue decidiendo cuándo concede tiempo de segundo plano y no deja leer Salud mientras el dispositivo está bloqueado.

El puente SwiftUI sigue disponible como alternativa local, pero ya no es necesario conectar el iPhone al Mac para alimentar la PWA.

## Registro automático de comida

- Foto: se reduce a JPEG antes del envío, Gemini estima el total y el registro se guarda automáticamente.
- Texto: acepta lenguaje cotidiano y marcas, por ejemplo `tres tercios Amstel`.
- Cada resultado conserva calorías, proteína, carbohidratos, grasa, confianza y los supuestos principales.
- La fila se puede tocar para corregir o eliminar. Una RPC recalcula el total del día de forma atómica.
- La función requiere una sesión de Supabase. `GEMINI_API_KEY` existe solo como secreto del proyecto.

## Cálculos

- Déficit del día: energía activa + energía basal - calorías ingeridas.
- Si faltan datos de energía, se utiliza el TDEE configurado.
- Con al menos tres pesajes, cuatro días de calorías y siete días de separación, se estima un TDEE adaptativo mediante la pendiente de peso.
- Masa magra estimada: peso × (1 - grasa corporal).
- Peso para un objetivo: masa magra / (1 - objetivo de grasa).
- Energía restante: kilos estimados × 7.700 kcal.
- Se presentan proyecciones con el déficit del último día y con el promedio de siete días.

Estas cifras son orientativas y no sustituyen consejo sanitario. La masa magra, hidratación y precisión de los dispositivos pueden cambiar.

## Desarrollo

```bash
npm test
npm run serve
```

Abre `http://localhost:4173`. Para probar el modo instalable y offline se requiere HTTPS o localhost.

Las integraciones cloud usan las funciones `health-import` y `hevy-sync`. Los secretos `INTEGRATION_ENCRYPTION_KEY` y `HEVY_CRON_SECRET` solo existen en Supabase. El job de `supabase/cron/hevy-sync.sql` ejecuta la sincronización de Hevy cada treinta minutos.

## Despliegue

GitHub es el repositorio y ejecuta las pruebas. La app con login se sirve desde un host estático compatible con `_headers`, no desde GitHub Pages. Consulta [PRIVACY.md](PRIVACY.md).
