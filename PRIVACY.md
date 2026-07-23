# Privacidad de CutTrack

CutTrack es una aplicación web estática con cuenta privada.

- Supabase guarda los ajustes, registros diarios y réplicas de Apple Salud y Hevy asociados al usuario autenticado.
- El navegador conserva una caché offline y una cola de cambios separadas por identificador de usuario.
- El repositorio no contiene datos personales, claves de API ni historiales de salud.
- La clave de Hevy se envía una vez a una Edge Function, se cifra con AES-GCM y no vuelve al navegador. La clave de cifrado existe solo como secreto de Supabase.
- Health Auto Export envía resúmenes diarios seleccionados mediante HTTPS. La clave de recepción solo permite escribir y la base conserva únicamente su hash.
- Garmin puede escribir sus métricas en Apple Salud. En ese caso pasan por Health Auto Export y se guardan con la misma protección.
- Las políticas de fila impiden que un usuario lea datos de otro. Salud y Hevy solo pueden escribirse mediante funciones autenticadas o claves de recepción aleatorias.
- La exportación JSON sí contiene los datos introducidos por el usuario. Debe tratarse como un archivo privado.
- Borrar la caché desde Ajustes elimina solo la copia del dispositivo y vuelve a descargar la cuenta.

## Fotos y texto de comida

La foto o el texto solo se envían cuando el usuario inicia un registro con IA. La imagen se comprime antes del envío. La función autenticada la envía a Gemini para obtener la estimación y la foto se guarda en un bucket privado de Supabase asociado al usuario. La clave de Gemini no se entrega al navegador. Los registros pueden corregirse o eliminarse desde la app.

Una aplicación web no puede leer Apple Health directamente. Sin instalar el puente nativo, Health Auto Export puede enviar peso, grasa corporal, pasos, sueño, energía y frecuencia cardiaca en reposo a CutTrack. iOS limita las ejecuciones en segundo plano y no permite acceder a Salud mientras el iPhone está bloqueado.
