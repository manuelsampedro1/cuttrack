# Privacidad de CutTrack

CutTrack es una aplicación web estática. GitHub Pages sirve únicamente los archivos de la interfaz.

- Los ajustes, registros diarios y entrenamientos se guardan en el almacenamiento local del navegador.
- El repositorio no contiene datos personales, claves de API ni historiales de salud.
- La clave de Hevy se utiliza para la sincronización solicitada y se retira del campo al terminar. No se incluye en la exportación ni se guarda en el almacenamiento permanente.
- La exportación JSON sí contiene los datos introducidos por el usuario. Debe tratarse como un archivo privado.
- Borrar los datos desde Ajustes elimina el almacenamiento local de CutTrack en ese dispositivo.

Una aplicación web no puede leer Apple Health directamente. Los valores de Apple Salud se introducen manualmente o se trasladan mediante una exportación creada por el usuario.

