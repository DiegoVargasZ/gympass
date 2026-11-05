# Migraciones SQLite

- Los archivos SQL usan un número consecutivo desde `001`, seguido de un nombre en minúsculas: `002_fotos.sql`.
- `001_base.sql` conserva exactamente el antiguo `schema.sql`, incluida su inserción original de la versión 1. Es la única excepción histórica a la regla de no escribir en `schema_version`.
- No cambies ni elimines migraciones publicadas. Añade una nueva para cada modificación del esquema o de los datos.
- No incluyas sentencias de control de transacciones (`BEGIN`, `COMMIT`, `ROLLBACK`) ni instrucciones que requieran ejecutarse fuera de ellas, como `VACUUM`.
- El runner en `server/database.ts` valida los nombres y la secuencia, adquiere un bloqueo con `BEGIN IMMEDIATE`, lee `MAX(version)` y ejecuta todas las pendientes dentro de esa misma transacción. Cada versión se registra al ejecutar su archivo.
- Si falla un archivo o el registro de su versión, se revierte todo el conjunto pendiente. Corrige el problema antes de volver a iniciar.
- Las bases con una versión superior a la última migración disponible se rechazan. No rebajes manualmente `schema_version` para forzar su apertura.

Antes de aplicar cambios a una base en uso, crea una copia con `npm run backup`. Las pruebas de `tests/database.test.ts` cubren instalación nueva, actualización de una base existente, orden, reapertura, rollback, reintento y rechazo de versiones futuras.
