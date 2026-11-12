# Cambios

## 5.0.0

- Web, Android y Windows actualizados a 5.0.0; Android usa el código 5000 y conserva el paquete y su firma.
- Windows incorpora las mejoras web recientes: logotipo del gimnasio, marca de agua y estilo de credenciales, vista previa de tarjeta, ajustes del tema oscuro y consultas de movimientos y horas por socio.
- Descargas directas del APK, instalador Windows y portable desde el acceso y Configuración.
- Se conserva la interfaz publicada 4.8.2 para las sesiones abiertas.

## 4.8.2

- Añadidas las dos grabaciones proporcionadas: el primer audio para la entrada y el segundo para la salida, con volumen ajustado sin saturación.
- Nueva opción «Audios de entrada y salida» en Apariencia, seleccionada por defecto para las preferencias automáticas anteriores. Se mantienen las voces elegidas y la opción de silenciar los avisos.
- Las pruebas de entrada y salida reproducen las grabaciones sin añadir nombres ni voces sintetizadas.
- El lector Android incluye los audios para usarlos sin conexión y descarta avisos pendientes cuando llega un movimiento nuevo.
- Web, Windows y Android actualizados a 4.8.2; Android usa el código 4802. Se conserva la interfaz publicada 4.8.1 para las sesiones abiertas.

## 4.8.1

- Verde oliva `#636B2F` en los botones principales de web, Windows y Android, con texto blanco legible.
- Restauradas las superficies anteriores de los temas claro y oscuro, sin invertir los colores de las barras de navegación.
- Apariencia muestra vistas previas de ambos temas y agrupa los avisos y sus controles de voz.
- La barra lateral contraída deja de mostrar el QR sobre los iconos; el menú móvil conserva el nombre del gimnasio.
- Web, Windows y Android actualizados a 4.8.1; Android usa el código 4801. Se conserva la interfaz publicada 4.8.0 para las sesiones abiertas.

## 4.8.0

- Paleta común con blanco como base del tema claro, negro como base del oscuro y verde fosforescente `#B6FF00` como acento. La composición sigue la proporción visual 60/30/10 en superficies, navegación y acciones.
- Menús, cabeceras, tablas, formularios, caja, socios, recepción, informes y configuración comparten los colores. Los botones verdes usan texto negro; los controles y avisos mantienen contraste legible.
- Cambio rápido de tema desde la barra y desde el acceso. Android incluye el cambio de tema en su navegación nativa y conserva la elección al volver a abrir el lector sin conexión.
- Web, Windows y Android actualizados a 4.8.0; Android usa el código 4800. Se conserva la interfaz 4.7.1 para las sesiones abiertas.

## 4.7.1

- El inicio local permite abrir la cuenta del servidor central sin sustituir la base de la computadora. Windows conserva la conexión directa al reiniciar, evitando volver a una copia vinculada a otra cuenta.
- La cabecera identifica servidor central, servidor local, copia sincronizada, desconexión y cambios pendientes. La comprobación de salud conserva su ruta central al entrar en un gimnasio.
- Botón para mostrar y ocultar las contraseñas de acceso, alta, recuperación y configuración en web y Windows; también en el lector nativo Android.
- Android actualizado al código 4701. Se conservan los recursos web 4.7.0 para las sesiones abiertas.

## 4.7.0

- Diez voces en español, selección por nombre y pruebas de entrada y salida.
- Voces optimizadas con descarga paralela, motor comprimido y reutilización de avisos; velocidad entre 50 % y 300 %.
- Botón Guardar cambios en Apariencia.
- Importación de archivos .gympassbackup con comprobación de integridad e identidad del gimnasio; restauración confirmada con copia previa.
- Android (código 4700) y Windows actualizados, conservando la identidad y los datos de las aplicaciones.
- Se conserva la web 4.6.0 para las sesiones abiertas.

## 4.6.0

- Consulta de presencia optimizada para reducir el coste del historial en recepción, informes y mantenimiento, conservando el resultado anterior.
- Respuestas JSON grandes comprimidas con Brotli o gzip según el cliente; las respuestas pequeñas se envían directamente.
- Colores de temas compatibles con Chrome y Edge 109; objetivos de compilación fijados y nuevas comprobaciones de compatibilidad y compresión en la verificación.
- Android (código 4600) y Windows actualizados a 4.6.0 con el código compartido y la interfaz actuales, conservando identidad y datos.
- Se conservan los recursos web publicados de 4.5.7 para las sesiones abiertas. Windows mantiene Electron 45 y la política existente de distribución sin firma de código.

## 4.5.7

- Restaurados los módulos de cámara QR actuales y anteriores. Se entregan todos los archivos emitidos por Vite y se prueban las importaciones entre comillas invertidas y la decodificación real de una imagen QR.
- La sincronización de escritorio deja libre la copia local mientras espera a Internet. Conserva las ediciones y cobros hechos durante una descarga o confirmación pendiente; cerrar cancela la espera y conserva el lote para reintentar.
- La carga del panel y la comprobación de cierres automáticos comparten correctamente la cola, sin esperar una tarea que está detrás de la petición actual.
- Corregido el aviso de conexión de escritorio para no pedir que dos equipos estén en la misma red Wi-Fi.
- Android y Windows actualizados a 4.5.7, conservando identidad y datos.

## 4.5.6

- Login aislado por cuenta, sin bloqueo compartido entre usuarios detrás del proxy. Cuenta fallos, protege intentos simultáneos y admite proxies confiables configurados.
- Inicio en cuatro pasos, incluyendo creación y cobro del plan antes de usar el QR.
- Retirado el cambio de gimnasio de las cuentas normales; el superadministrador conserva el soporte.
- Fuente web y dependencias de compilación versionadas. GitHub verifica tipos, compila y despliega el artefacto probado.
- Retención de la interfaz actual y la anterior; retirada de recursos y descargas antiguas del directorio público.
- Módulos antiguos disponibles solo para consulta histórica autorizada; sus escrituras devuelven 410. Se conservan datos y migraciones.
- Los informes actuales de accesos y sus consultas guardadas siguen disponibles.
- Documentación de instalación, operación e historial separada.
- Android y Windows actualizados a 4.5.6.

El historial anterior se conserva en [HISTORIAL-HASTA-4.5.5.md](HISTORIAL-HASTA-4.5.5.md).
