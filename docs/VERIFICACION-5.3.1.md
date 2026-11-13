# Verificación de GymPASS 5.3.1

Fecha: 13 de noviembre de 2026. Alcance: web y servidor, sincronización y respaldos. Los instaladores oficiales Android/Windows permanecen en 5.3.0 y conservan el mismo protocolo.

## Cambios comprobados

- Revisión persistente de datos con disparadores transaccionales; una renovación de dispositivo no invalida la revisión. Las ediciones, eliminaciones, lotes fusionados, cambios de esquema y metadatos de recursos sí se comprueban.
- Sondeo sin cambios antes de cargar tablas, fotos o JSON histórico. Sigue verificando cuenta, gimnasio, dispositivo y autorización offline; no se amplía el permiso por encima de siete días.
- Instantáneas completas generadas con iteradores SQLite y bloques pequeños. Se fija una transacción de lectura independiente y una copia de recursos mediante enlaces físicos o copia, manteniendo la consistencia mientras recepción/caja escriben. Los cambios de archivos por replicación reemplazan el archivo de forma atómica para conservar recursos ya fijados.
- Compresión por flujo y validación de permisos durante transferencias. El cierre de conexiones o errores corta la transferencia y libera lectores/temporales; una copia truncada no se presenta como descarga completa.
- Historial móvil seleccionado desde SQL: últimos 10.000 eventos más las entradas vigentes necesarias. La validación de un lote entrante usa metadatos de esquema y no materializa el historial.
- Descarga e importación web por flujo hasta 4 GiB; archivos recibidos en disco, comprobación de espacio libre, manifiestos/hashes/identidad y procesamiento de respaldos en trabajador con heap limitado. Los métodos antiguos que devuelven un único buffer conservan su límite de 256 MiB; las rutas web usan el flujo nuevo.
- Descargas individuales fuera de la cola de la base activa. Restauración con confirmación, contraseña, identidad, copia previa y nueva verificación de permisos/credenciales antes de escribir el plan de restauración.
- Un calendario automático de plataforma, diario, con 14 copias completas. No genera además otras 14 copias diarias individuales. Conserva los respaldos anteriores; reutiliza recursos inmutables iguales entre copias nuevas cuando el sistema permite enlaces físicos. Se comprueba el hash del recurso reutilizado y no se enlaza el archivo activo a las copias de respaldo.
- Una transferencia pesada activa por proceso; hasta cuatro esperas breves de 100 ms antes de rechazar con 429 y `Retry-After: 5`. El cupo se reserva antes de recibir el JSON grande o archivo. La ruta de revisión sin cambios puede responder con ese cupo ocupado.

## Pruebas

`npm run verify` completa compilación, comprobación de tipos, 69 comprobaciones de integración y 115 pruebas: **184 aprobadas, cero fallos**. Se verifican los manifiestos y huellas de la web actual y de 5.3.0 retenida, además de que los enlaces de instaladores corresponden a una entrega nativa publicada.

Las pruebas de regresión cubren reintentos con respuesta perdida, pagos y QR idempotentes, conflictos offline, costos históricos, clientes anteriores, revocación, permisos de respaldo, importación y restauración. Las nuevas pruebas de `tests/sync-backup-resources.test.ts` comprueban además:

1. Renovación sin consultas completas de datos y sin consumir el cupo de transferencia pesada.
2. Equivalencia del contenido enviado con el snapshot de protocolo 1, incluidos archivos base64 y esquema sin costos de clientes antiguos.
3. Exportación e importación verificadas de una copia superior a 260 MiB; los bloques de archivo no superan 64 KiB y se rechaza una identidad de gimnasio diferente.
4. Escritura en el mismo gimnasio durante una descarga pausada; la respuesta conserva la instantánea anterior coherente.
5. Recorte móvil desde SQL y conservación de una entrada vigente fuera de los últimos 10.000 movimientos.
6. Reutilización de recursos entre copias inmutables sin compartir el archivo activo y sin duplicar el calendario diario.

La prueba adicional de descarga nativa comprueba que los respaldos centrales se guardan mediante el navegador, sin materializar el archivo completo en un Blob de JavaScript. La ruta conserva la autenticación por cookie y el nombre que entrega el servidor.

## Medición local con el historial del informe

Se copió el conjunto sintético anterior a un directorio nuevo, sin abrir datos reales. Mismos 250.018 eventos, 1.000 personas y 25.000 ventas; sin fotos. Node.js 24.21.0, Ryzen 5 7535HS, Windows y 15,2 GiB RAM.

| Medida | Resultado observado |
| --- | --- |
| Mayor RSS del proceso durante tres descargas completas por flujo | 131,3 MiB |
| Duración mediana de esas descargas HTTP locales, sin compresión | 2.253 ms |
| Mediana de diez sondeos sin cambios | 6,16 ms |
| Tamaño de la respuesta sin cambios | 432 bytes |
| Mayor retraso observado del temporizador durante las descargas | 9,93 ms |

El informe anterior observó alrededor de 940 MiB al construir y serializar la copia completa en memoria. Es una comparación descriptiva de memoria: el método anterior materializaba objetos/JSON/buffer y el nuevo mide una transferencia HTTP cuyo cliente descarta los bloques. No se compara directamente la latencia anterior de construcción con la nueva descarga HTTP completa. La medición usa autorización sintética; las pruebas funcionales anteriores sí ejercitan la autorización real.

No se deduce de estas cifras un máximo de gimnasios en Namecheap. No incluyen TLS, proxy, cuotas LVE, fotos, copias simultáneas de otras aplicaciones ni la memoria del cliente al instalar la copia. Los artefactos locales están en `output/db-review-2026-11-13/`, ignorados por Git.

## Límites que se conservan

Esta entrega mantiene snapshots completos cuando hay cambios para conservar compatibilidad con los clientes instalados. Un protocolo de diferencias entre filas requerirá una entrega coordinada de clientes. La copia global sigue pausando las colas de gimnasios para capturar un conjunto coherente; no se ofrece una copia global sin pausa. La lectura de la base central para esa copia todavía utiliza una instantánea síncrona antes del trabajo separado.

El límite de 4 GiB también depende del espacio libre y de los límites de red/proxy del hosting. Las subidas tienen un plazo de 30 minutos; las descargas de sincronización se limitan a dos minutos para no fijar un lector WAL de manera indefinida. Una respuesta 429 se puede reintentar y no elimina los pendientes del dispositivo.

No se ha configurado una cuenta externa para copias automáticas ni cifrado integral de SQLite/archivos descargados. Eso requiere definir el destino y la gestión de claves. Las copias previas duplicadas se conservan y no se libera ese espacio retroactivamente de forma silenciosa.
