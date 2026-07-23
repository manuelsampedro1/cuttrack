# CutTrack PWA

PWA instalable y local-first para estimar déficit energético, seguir proteína, peso, composición corporal y entrenamientos de Hevy.

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

## Privacidad

Los datos se guardan en `localStorage` del navegador. No se envían a GitHub. Consulta [PRIVACY.md](PRIVACY.md).

