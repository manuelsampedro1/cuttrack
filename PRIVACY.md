# Privacidad de CutTrack

CutTrack es una aplicación web estática con cuenta privada.

- Supabase guarda los ajustes, registros diarios y réplicas de Apple Salud y Hevy asociados al usuario autenticado.
- El navegador conserva una caché offline y una cola de cambios separadas por identificador de usuario.
- El repositorio no contiene datos personales, claves de API ni historiales de salud.
- La clave de Hevy solo se guarda en Keychain dentro del iPhone. La web no la recibe.
- Apple Salud solo se lee desde la app iOS después del consentimiento. Se suben resúmenes diarios, no nombres de dispositivos, metadatos completos ni muestras brutas de pasos o energía.
- Las políticas de fila impiden que un usuario lea datos de otro. Salud y Hevy solo pueden escribirse mediante funciones que verifican el iPhone vinculado.
- La exportación JSON sí contiene los datos introducidos por el usuario. Debe tratarse como un archivo privado.
- Borrar la caché desde Ajustes elimina solo la copia del dispositivo y vuelve a descargar la cuenta.

Una aplicación web no puede leer Apple Health directamente. El puente nativo sincroniza peso, grasa corporal, pasos, sueño, energía y frecuencia cardiaca en reposo con la misma cuenta.
