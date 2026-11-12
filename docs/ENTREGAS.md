# Política de entregas

## Web reproducible

`package-lock.json` fija las dependencias. Ejecuta `npm ci` y `npm run verify` sobre un checkout limpio. La compilación usa `src/`, `lib/`, `vendor/`, `public/` y la configuración versionada. `dist/release.json` guarda la versión, una huella de las entradas y las huellas de los recursos actuales. No incluye datos del gimnasio ni secretos.

GitHub Actions publica el mismo `dist/` generado y verificado en su trabajo de comprobación. Una modificación directa de los archivos compilados se reemplaza durante la compilación.

## Retención de recursos

Se distribuyen dos conjuntos: el actual y el descrito en `web-releases/previous.json`. Para 4.8.2 se conserva el grafo completo publicado de 4.8.1. Esto permite que sus pestañas abiertas soliciten sus pantallas diferidas tras actualizar. Las sesiones de versiones anteriores deben recargarse.

Los lectores QR referenciados por clientes existentes se conservan además en `web-releases/compatibility.json`. La compilación entrega **todos** los recursos emitidos por Vite y valida las importaciones de JavaScript mediante su árbol de sintaxis, incluidas las cadenas entre comillas invertidas. No se eliminan archivos de la compilación actual basándose en una búsqueda textual.

Durante la recuperación de 4.5.7 se conserva también la interfaz 4.5.5 en ese manifiesto, para que los clientes abiertos antes de la actualización puedan seguir cargando sus pantallas.

Para preparar una versión posterior:

1. Desde la versión actual compilada, ejecuta `npm run release:retain` para guardar su manifiesto como versión anterior.
2. Actualiza la versión, los enlaces de descarga y los manifiestos de los clientes.
3. Ejecuta `npm run verify` y versiona fuente, lockfile, manifiesto de retención y compilación.
4. Compila los clientes, comprueba sus arranques y publica sus instaladores antes de desplegar los nuevos enlaces web.

La compilación comprueba las huellas de los recursos retenidos, genera y comprime la nueva interfaz en staging y solo entonces actualiza `dist/`. Los archivos obsoletos se eliminan únicamente de `dist/assets/`. Los APK y EXE se alojan en GitHub Releases; `dist/descargas/` deja de contener instaladores antiguos.

## Android y Windows

Los proyectos locales de clientes se conservan en `GymPASS/acceso/mobile` y `GymPASS/acceso/desktop`. La copia local de `src/`, `lib/` y el servidor compartido debe coincidir con este repositorio antes de preparar el runtime de Windows. Las claves de licencia y firma permanecen fuera de Git.

Los cambios nativos de 4.8.1 a 4.8.2 están en `client-releases/4.8.2-native.patch`, incluidas sus pruebas, fuentes compartidas, audios y versiones. Sobre las fuentes locales 4.8.1, aplica primero `git apply --check --directory=acceso pagina/gympass/client-releases/4.8.2-native.patch` desde `GymPASS/` y después el mismo comando sin `--check`. Los parches anteriores se conservan para las instalaciones de desarrollo más antiguas. Los parches no contienen datos ni claves.

Android se compila con `mobile/scripts/build-android.ps1`, reutilizando la firma existente. Antes de publicar, ejecuta `node scripts/check-android-start.mjs RUTA_AL_APK emulator-5554`: instala únicamente en emulador y comprueba dos arranques en frío. Verifica que el certificado coincida con la versión anterior.

Windows se prepara con `npm run dist:desktop` desde el proyecto local. Comprueba el arranque del ejecutable generado y conserva la política de firma existente. Publica APK, instalador, portable y un archivo SHA-256 en la misma entrega. No sustituyas silenciosamente un archivo ya publicado por otro con el mismo nombre.
