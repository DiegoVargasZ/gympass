# Revisión de bases de datos de GymPASS

Fecha: 13 de noviembre de 2026. Versión: 5.3.0. Código revisado: `7054053fae14918b21320e28424446f5b63e9278`.

Este documento conserva el diagnóstico anterior a las correcciones. La implementación posterior de sincronización y respaldos se documenta en la [verificación de 5.3.1](VERIFICACION-5.3.1.md); sus límites y mediciones deben leerse con esa actualización.

## Resultado ejecutivo

**La separación de datos y permisos entre gimnasios tiene una base sólida. La capacidad para muchos gimnasios activos todavía tiene cuellos de botella importantes**, especialmente en sincronización, memoria, respaldos y consultas del historial. El hosting básico no permite prometer una cantidad concreta de gimnasios concurrentes con las comprobaciones disponibles.

En una prueba local aislada, un gimnasio con aproximadamente 250.000 movimientos, 1.000 personas y 25.000 ventas produjo una base de 184,6 MiB. Preparar y serializar una sincronización completa tardó una mediana de 2,17 segundos y el proceso alcanzó unos 940 MiB de RAM, sin fotos. Esto deja muy poco margen en un alojamiento con alrededor de 1 GB de memoria.

No encontré en el alcance revisado un acceso directo reproducible de un gimnasio a los datos de otro. Eso no constituye una certificación de seguridad. El compromiso de la cuenta del hosting o del proceso servidor afectaría a todos los archivos que esa cuenta pueda leer.

Esta revisión no cambia código de la aplicación, datos reales, configuración ni despliegues. Conserva el informe anterior del 6 de noviembre como documento histórico independiente.

## Alcance y evidencia

- Lectura de autenticación y autorización, almacenamiento central y por gimnasio, migraciones, consultas, replicación, respaldos y restauración. Backend Node.js HTTP nativo y SQLite; no se asumió Express. La guía de seguridad disponible cubre JavaScript/TypeScript y frontend, sin una referencia específica para este backend HTTP nativo; los hallazgos del servidor se apoyan en código, pruebas y fuentes primarias.
- Pruebas con archivos y cuentas sintéticas dentro de `output/db-review-2026-11-13/`, carpeta ignorada por Git. No se abrieron bases de socios reales para estas mediciones.
- Equipo: Windows, Ryzen 5 7535HS, 12 procesadores lógicos, 15,2 GiB de RAM; Node.js 24.21.0 y SQLite 3.53.4. Los tiempos no representan el rendimiento de Namecheap.
- 43 pruebas relevantes aprobadas, ninguna fallida: permisos entre gimnasios, revocaciones, política de acceso, límites de login, sincronización, migraciones, restauración y costos de productos. `npm audit --omit=dev` informó cero vulnerabilidades conocidas en las dependencias de producción consultadas; esto no audita Node, SQLite ni el servidor contratado.
- No se inspeccionaron cPanel, permisos efectivos de producción, límites LVE efectivos, disco ocupado, registros reales, copias externas del proveedor ni todas las rutas de cada cliente. No se realizó una prueba de carga autenticada sobre producción.

## Cómo se organizan los datos

| Componente | Contenido y aislamiento |
| --- | --- |
| `platform.sqlite` | Cuentas, sesiones, gimnasios, membresías de usuarios administrativos, soporte, auditoría y facturación de plataforma. 14 tablas en la inspección sintética. |
| `tenants/<UUID>/gympass.sqlite` | Personas, credenciales, entradas/salidas, visitas, zonas, horarios, planes, productos, costos, ventas y stock de un gimnasio. 30 tablas tras las 25 migraciones, incluyendo tablas auxiliares e internas; la sincronización agrega sus propias tablas al inicializarse. |
| Archivos por gimnasio | Fotos, marca, fondos y `credentials.key`. Las fotos ocupan disco fuera de SQLite y también pueden entrar en respaldos y sincronizaciones. |
| Escritorio y móvil | Copias locales para operación sin conexión. Son otras superficies de datos: revocar un dispositivo no equivale a borrar remotamente los archivos ya descargados. |

Cada gimnasio tiene su propio archivo, identidad y clave de credenciales. Se valida el UUID y la identidad `settings.owner` antes de usarlo ([tenant-manager.ts:142](../server/tenant-manager.ts#L142)). Las cuentas administrativas de plataforma son la autoridad; las tablas locales antiguas de usuarios/sesiones no se usan como fuente de autenticación multigimnasio.

La autorización verifica sesión vigente, pertenencia al gimnasio, rol, estado operativo y alcance de soporte ([platform-store.ts:288](../server/platform-store.ts#L288)). También vuelve a comprobar permisos inmediatamente antes de ejecutar SQL ([authorized-database.ts:3](../server/authorized-database.ts#L3)). Esto protege frente a permisos revocados mientras una petición espera en cola.

## Controles que están bien

- SQL parametrizado en las operaciones revisadas; los nombres dinámicos de tablas de replicación proceden de listas controladas. No se identificó una inyección SQL reproducible en este alcance.
- Claves foráneas activadas, transacciones con rollback y migraciones numeradas. Los identificadores de petición ayudan a impedir cobros y movimientos duplicados en reintentos.
- Dinero en centavos enteros y costo histórico por línea de venta; cambiar el costo actual de un producto no reescribe automáticamente la utilidad de ventas anteriores.
- Contraseñas con scrypt y sal aleatoria, comparación de hashes resistente a diferencias de tiempo; tokens aleatorios almacenados mediante hash. Cookies con HttpOnly/SameSite y configuración Secure para producción.
- Límites de intentos de login compartidos por los accesos web/móvil, controles de origen para operaciones web y validación de rutas/archivos de respaldo.
- Restauración con controles de identidad de gimnasio, hashes, integridad y claves foráneas, copia previa y mecanismos para recuperar interrupciones. Una copia descargada solo cuenta como recuperación verificada cuando se restaura y comprueba.

## Hallazgos de prioridad alta

### BD-01. Una sincronización grande puede afectar a todos los gimnasios

**Impacto:** un gimnasio con mucho historial o varios dispositivos puede consumir la memoria y bloquear temporalmente el procesamiento compartido del resto.

`replicaTables` carga tablas completas mediante `SELECT *` y `.all()` ([replication.ts:145](../server/replication.ts#L145)). El lector móvil limita parte del historial después de cargarlo, no mediante un límite SQL. Las sincronizaciones de escritorio/gestión también leen archivos y crean cadenas base64 en memoria ([replication.ts:187](../server/replication.ts#L187)).

Se construye la copia y su hash **antes** de comprobar si la revisión ya coincide ([replication-api.ts:164](../server/replication-api.ts#L164)). Si no hubo cambios, la respuesta es pequeña, pero el servidor igualmente recorrió y materializó los datos. El cliente de escritorio intenta sincronizar cada 10 segundos ([replica-client.ts:567](../server/replica-client.ts#L567)).

SQLite se ejecuta en el hilo principal con `DatabaseSync`; las funciones marcadas `async` no convierten las consultas en trabajo paralelo. La [documentación de Node 24](https://nodejs.org/download/release/v24.11.0/docs/api/sqlite.html#class-databasesync) confirma que esta API es síncrona. La prueba de 250.000 eventos registró retrasos del bucle de eventos de aproximadamente 1,58 a 2,42 segundos durante la construcción de las copias.

Además, la recepción admite JSON de hasta 64 MiB y lotes de hasta 100.000 cambios ([replication-api.ts:149](../server/replication-api.ts#L149), [replication.ts:309](../server/replication.ts#L309)). Son límites existentes, pero altos para este hosting. No se identificaron cuotas generales por gimnasio de CPU, memoria o solicitudes simultáneas de sincronización. El abuso descrito requiere acceso a una ruta/dispositivo autorizado; no se demostró un ataque anónimo contra producción.

**Corrección prioritaria:** revisión barata antes de reconstruir datos, descarga incremental de cambios, paginación de instantáneas, archivos separados del JSON, límites por gimnasio y presupuesto global de concurrencia. Separar consultas pesadas/compresión del hilo que atiende las peticiones.

### BD-02. El respaldo descargable tiene un techo de 256 MiB

**Impacto:** la base puede seguir creciendo y funcionando aunque su copia ya no pueda exportarse o importarse por el mecanismo actual.

El respaldo por gimnasio tiene un límite de 256 MiB para el contenedor completo, incluidos base, recursos y cabecera ([backup-limits.ts:1](../lib/backup-limits.ts#L1), [backup-transfer.ts:60](../server/backup-transfer.ts#L60)). La descarga de plataforma también rechaza más de 256 MiB sumados de archivos **antes de comprimir**, aunque entregue `.tar.gz` ([platform-backup-export.ts:70](../server/platform-backup-export.ts#L70)). El límite global se comparte entre todos los gimnasios incluidos.

Exportar carga archivos completos y concatena buffers; la exportación global también comprime de manera síncrona. Subir únicamente el número del límite incrementaría el riesgo de agotar RAM y bloquear peticiones.

Ejemplo calculado, no prueba adicional: la base medida de 184,6 MiB más 1.000 fotos de 100 KiB suma unos 282,3 MiB, ya por encima del límite, sin contar los demás archivos. El umbral exacto depende de cada gimnasio.

**Corrección prioritaria:** exportación e importación por flujo, límites acordes al almacenamiento y verificación periódica de restauración fuera del servidor activo.

### BD-03. Las copias locales multiplican disco y archivos; no aíslan un desastre del hosting

Por defecto se guardan 14 copias automáticas por gimnasio, cada 24 horas ([backups.ts:387](../server/backups.ts#L387)), y otras 14 copias completas de plataforma ([tenant-manager.ts:290](../server/tenant-manager.ts#L290)). Al llenarse ambas retenciones, un gimnasio estable puede tener aproximadamente **29 veces** sus datos: original + 14 copias individuales + 14 dentro de las globales. No es un factor exacto para datos que crecen o cambian; las copias manuales y previas a actualizaciones pueden agregar más espacio.

Escenarios calculados de almacenamiento, no capacidad de concurrencia:

| Datos activos por gimnasio, con recursos | Gimnasios | Originales + ambas retenciones llenas |
| --- | --- | --- |
| 100 MiB | 5 | Aproximadamente 14,2 GiB |
| 100 MiB | 10 | Aproximadamente 28,3 GiB |

El respaldo global espera las colas y copia síncronamente todas las bases y recursos, pausando nuevas operaciones de los gimnasios ([tenant-manager.ts:232](../server/tenant-manager.ts#L232)). El tiempo de pausa aumenta con el volumen.

No se encontró una integración automática del código para enviar copias cifradas a otra cuenta/proveedor. No se verificó qué protección externa tenga contratado el hosting. Copias en la misma cuenta no protegen por sí solas ante borrado total, pérdida de la cuenta o compromiso de sus credenciales.

**Corrección prioritaria:** diseñar retenciones coordinadas y alertas de disco/archivos, sacar una copia cifrada fuera de esa cuenta y medir restauraciones. Programar el trabajo pesado con una estrategia que reduzca la pausa global.

## Hallazgos de prioridad media

### BD-04. Los archivos SQLite y respaldos contienen datos personales legibles

El cifrado AES-256-GCM protege códigos QR recuperables ([credential-vault.ts:23](../server/credential-vault.ts#L23)); no cifra toda la base. Nombres, documentos, teléfonos y operaciones siguen accesibles a quien pueda leer el archivo SQLite. Las copias incluyen la clave de credenciales junto con los datos ([tenant-manager.ts:261](../server/tenant-manager.ts#L261), [backups.ts:29](../server/backups.ts#L29)). Compresión y hashes de integridad no son cifrado.

Es un riesgo ante robo de copias, dispositivo o cuenta de hosting; no evidencia que los archivos sean públicos. La ruta de datos debe permanecer fuera del directorio servido por web, con permisos privados. No se verificó su ubicación ni permisos efectivos en producción. Las cuentas y copias locales de escritorio/móvil necesitan protección del sistema operativo y una política de baja de dispositivos.

**Mejora:** permisos mínimos, MFA de las cuentas de administración/hosting, protección del equipo y cifrado de copias externas con una clave guardada fuera de la copia. Evaluar cifrado en reposo según el entorno y el modelo de acceso.

### BD-05. Varias consultas aumentan su costo con el historial

La consulta de presencia recorre eventos históricos para obtener pares distintos y el último movimiento por persona/zona ([service.ts:127](../lib/service.ts#L127)). El índice existente ayuda a buscar el último evento de cada par, pero no elimina el recorrido histórico observado. La carga inicial la reutiliza y consulta los 12 eventos más recientes ([service.ts:201](../lib/service.ts#L201)).

`EXPLAIN QUERY PLAN` mostró una tabla temporal para `DISTINCT` y otra para ordenar los eventos recientes. En este esquema no hay un índice global que coincida con `ORDER BY occurred_at DESC,id DESC`. La carga inicial creció de 22 a 471 ms y el registro de acceso probado de 13 a 222 ms entre los extremos del conjunto sintético.

**Mejora:** medir y añadir el índice cronológico global apropiado; evaluar estado de presencia mantenido transaccionalmente y resúmenes para reportes. Preservar el historial y validar entradas, salidas retroactivas y correcciones antes de sustituir consultas.

### BD-06. Falta una política completa de crecimiento y eliminación

Los lotes de sincronización guardan JSON de cambios, incluidos datos anteriores/nuevos, en `sync_batches.patch_json` ([replication.ts:45](../server/replication.ts#L45), [replication.ts:576](../server/replication.ts#L576)). No se encontró una política de depuración de estos lotes; sí se borran permisos de sincronización vencidos. Esto puede duplicar información y hacer que una base real crezca más que el benchmark.

Tampoco se identificaron cuotas generales de almacenamiento por gimnasio. Las bajas lógicas y los respaldos conservan datos; eliminar un socio en la interfaz no garantiza borrado físico de todas sus copias. La prueba local observó `secure_delete=0`, sin que eso confirme el ajuste de producción.

**Mejora:** acordar retención de historial, lotes, auditorías y copias; aplicar cuotas y alertas. La depuración de sincronización debe respetar idempotencia, conflictos y dispositivos que pueden permanecer sin conexión.

### BD-07. La política de contraseñas admite claves débiles

Se aceptan seis caracteres y se usa scrypt sin parámetros explícitos ([auth.ts:6](../server/auth.ts#L6)). En el Node utilizado esto implica sus valores predeterminados `N=16384, r=8, p=1`, documentados en [Node 24 Crypto](https://nodejs.org/download/release/v24.11.0/docs/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback). No se identificó un segundo factor de autenticación propio de la aplicación.

Hay sal y límite de intentos, por lo que no se almacenan contraseñas en claro ni existe un login sin defensa. Sin embargo, una contraseña de seis caracteres puede ser débil y el costo de derivación queda por debajo del perfil scrypt `N=2^17, r=8, p=1` recomendado como una opción mínima por [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

**Mejora:** contraseñas más largas, rechazo de claves conocidas y MFA administrativo. Versionar los parámetros del hash y migrarlos al iniciar sesión. Aumentar el costo requiere medir memoria y limitar derivaciones simultáneas: hacerlo sin ese control en un hosting pequeño puede agravar BD-01.

## Capacidad medida: datos, consultas y memoria

El mismo gimnasio sintético mantuvo 1.000 personas con credenciales y un producto con costo y precio; se agregaron movimientos y ventas hasta cada etapa. Las personas de prueba eran empleados, por lo que no se simularon todas las reglas de membresías. No había fotos ni un historial grande de lotes offline.

| Movimientos aproximados | Ventas | Archivo SQLite tras checkpoint | Carga inicial, mediana | Registrar acceso, mediana | Construir y serializar copia completa, mediana | Mayor RAM del proceso observada en las 3 copias |
| --- | --- | --- | --- | --- | --- | --- |
| 10.000 | 1.000 | 8,3 MiB | 22 ms | 13 ms | 80 ms | 146 MiB |
| 100.000 | 10.000 | 73,4 MiB | 203 ms | 88 ms | 862 ms | 503 MiB |
| 250.000 | 25.000 | 184,6 MiB | 471 ms | 222 ms | 2.171 ms | 940 MiB |

Los conteos finales exactos fueron 10.006, 100.012 y 250.018 eventos, porque la propia prueba agregó accesos. Se tomaron cinco muestras por consulta y tres por copia; el primer snapshot de la última etapa tardó 3,04 segundos. La RAM es la del proceso completo en ese benchmark, no memoria incremental por gimnasio, una cuota fija ni una garantía de pico máximo. La prueba no restringió el proceso a 1 GB.

La respuesta completa serializada pesó 6,7, 60,1 y 149,2 MiB respectivamente. Solo se envía completa si hace falta; una revisión sin cambios devuelve una respuesta reducida, aunque todavía construye los datos para compararlos. La construcción sin serializar la respuesta completa tuvo medianas aproximadas de 56, 631 y 1.601 ms.

Se midió la lógica real de servicio y construcción de snapshots más su serialización a JSON/buffer. No se incluyen red, TLS, proxy, límites de Namecheap ni colas de usuarios reales. Las muestras pequeñas no permiten calcular capacidad sostenida ni percentiles fiables de producción.

`quick_check` resultó `ok`. Una copia local de la base mayor tardó aproximadamente 811 ms. Eso verifica ese archivo sintético en ese momento, no la integridad de bases de producción.

### Integridad, durabilidad y recuperación

El código activa WAL, claves foráneas y `busy_timeout=5000` en las bases central y de gimnasio ([database.ts:82](../server/database.ts#L82), [platform-store.ts:109](../server/platform-store.ts#L109)). El plazo de espera de un bloqueo no es una garantía de latencia para una petición completa.

En las bases sintéticas se observaron páginas de 4 KiB, `synchronous=FULL` y checkpoint automático de WAL a 1.000 páginas. FULL con WAL ofrece una protección de durabilidad mayor frente a cortes de energía que NORMAL, según la [documentación de SQLite](https://www.sqlite.org/pragma.html#pragma_synchronous). El código no fija explícitamente todos esos valores: deben comprobarse en la compilación y almacenamiento de producción. La persistencia efectiva también depende del sistema de archivos y del disco del proveedor.

El umbral de checkpoint no es un límite estricto del tamaño del WAL; lectores o checkpoints bloqueados pueden hacerlo crecer. Debe vigilarse junto con el espacio libre. No se debe copiar únicamente el archivo `.sqlite` activo ignorando su WAL para improvisar un respaldo: el sistema revisado usa instantáneas SQLite, que conservan un estado coherente.

Con copias cada 24 horas, si todas se completan correctamente, la última copia puede quedar aproximadamente un día por detrás de los datos actuales. Una copia fallida o no supervisada empeora esa ventana. No se midió el tiempo completo de recuperación de una instalación real; los 811 ms anteriores son solo creación de una copia sintética local, no un plazo prometido de restauración.

### Cuántos datos pueden guardar

SQLite no tiene un límite pequeño de socios o gimnasios. Con páginas de 4.096 bytes y el máximo de páginas observado localmente, el techo teórico del archivo ronda 17,6 TB decimales (16 TiB), muy por encima de este hosting. No representa capacidad operativa de GymPASS. Véanse los [límites oficiales de SQLite](https://www.sqlite.org/limits.html).

En este conjunto, el incremento de **eventos con sus índices** fue de unos 664–694 bytes por movimiento, separando el agregado de ventas. Un millón de eventos estaría aproximadamente en 0,65–0,70 GB decimales solo para esa parte: es una extrapolación, no una prueba con un millón. Personas, ventas, fotos, WAL, sincronización y copias se agregan aparte; tamaños de texto y uso real cambian la cifra.

Ejemplos de crecimiento anual si cada visita registra entrada y salida:

- 200 visitas diarias: unos 146.000 movimientos al año.
- 500 visitas diarias: unos 365.000 movimientos al año.

No existe una cantidad de socios certificada en esta revisión. Solo se probó el conjunto de 1.000 personas; un gimnasio de pocos socios con años de movimientos y muchas fotos puede pesar más que otro con muchos socios nuevos.

## Cuántos gimnasios pueden operar al mismo tiempo

**No es correcto afirmar que soporta 32 gimnasios como límite comercial, ni prometer 50 o 100 con este hosting.** El valor predeterminado 32 es la cantidad de contextos/base abiertos en caché, configurable mediante `GYMPASS_MAX_OPEN` ([app.js:15](../app.js#L15)). Se pueden registrar más: el administrador cierra un contexto inactivo y abre otro.

Se crearon 33 gimnasios sintéticos. Al mantener artificialmente ocupadas operaciones de 32 gimnasios diferentes, la operación del número 33 recibió HTTP 503; al liberarlas volvió a funcionar. Es una prueba del comportamiento de caché saturada, **no** una prueba de capacidad real de 32 gimnasios atendiendo usuarios. Aumentar el número no agrega CPU ni RAM y puede empeorar consumo.

Las operaciones de un mismo gimnasio pasan por una cola. Los distintos gimnasios usan archivos separados, pero comparten proceso, memoria y el hilo que ejecuta SQL. WAL permite lectores junto a un escritor, pero solo un escritor simultáneo por archivo; requiere un almacenamiento compatible y no debe compartirse mediante un sistema de archivos de red entre hosts. Véase [SQLite WAL](https://www.sqlite.org/wal.html). La cola de GymPASS es más conservadora que las posibilidades de lectura de WAL.

También hay un bloqueo para impedir dos procesos de plataforma sobre el mismo directorio de datos ([platform-lock.ts](../server/platform-lock.ts)). No basta con activar más procesos de Node sobre esa carpeta para obtener escalado horizontal.

Para dimensionar se necesitan: gimnasios realmente activos, personas por gimnasio, movimientos históricos, fotos, lectores/PC por sede, frecuencia de sincronización, pico de entradas/cobros y duración de copias. Varios gimnasios pequeños pueden ser más baratos que uno grande que sincroniza continuamente. El benchmark demuestra que **incluso una sola sede con historial considerable puede acercarse al presupuesto de memoria del plan básico**.

## Qué implica tu plan de aproximadamente USD 1,20

El precio promocional por sí solo no identifica el plan ni los recursos contratados. Como referencia condicional, Namecheap publica para el alojamiento compartido básico 1 GB de RAM, CPU limitada al 50%, 20 procesos de entrada e I/O de 50 MB/s; los procesos de entrada no equivalen a gimnasios ni a usuarios conectados. Deben confirmarse los límites efectivos en cPanel → Resource Usage. [Fuente oficial de recursos](https://www.namecheap.com/support/knowledgebase/article.aspx/1127/103/a-handy-guide-to-resource-limits-or-what-is-lve/).

Si es Stellar, la comparación oficial indica 20 GB SSD. Sus límites de tres dominios o 50 bases MySQL **no significan** tres o 50 gimnasios: GymPASS usa archivos SQLite dentro de una aplicación. [Comparación de planes](https://www.namecheap.com/support/knowledgebase/article.aspx/10112/22/shared-hosting-plans-comparison/).

Stellar/Stellar Plus tienen una referencia de 300.000 archivos/directorios (inodos). Namecheap también indica que, excepto Stellar Business, superar 200.000 excluye la cuenta del respaldo automático de su servidor. Ejemplo calculado: 10 gimnasios × 1.000 fotos × 29 conjuntos de original/copias ya suponen aproximadamente 290.000 fotos, antes de sumar código, correo y otros archivos. No es el consumo real de tu cuenta. [Límites oficiales de inodos y respaldos](https://www.namecheap.com/support/knowledgebase/article.aspx/9331/29/how-to-check-the-number-of-inodes-in-your-hosting-account/).

Este plan debe tratarse como una instalación inicial con vigilancia de recursos, no como capacidad multigimnasio garantizada. No recomendaría vender un número fijo de sedes simultáneas hasta corregir los snapshots/respaldos y hacer una carga representativa bajo los límites efectivos del hosting.

## Orden recomendado de trabajo

1. Resolver BD-01 y BD-02: sincronización incremental y respaldos por flujo, con límites de memoria/concurrencia.
2. Resolver BD-03: retenciones coordinadas, copias cifradas fuera de la cuenta y restauración comprobada; alertas de disco, inodos y antigüedad de copia válida.
3. Optimizar consultas de historial y establecer cuotas/retención por gimnasio sin perder idempotencia offline.
4. Reforzar contraseñas y administración, proteger archivos y dispositivos locales y revisar permisos reales del directorio de datos.
5. Medir bajo el presupuesto efectivo del hosting: mezcla real de entradas, cobros, paneles, dispositivos y copias; observar latencias p95/p99, fallos 503, reinicios, RAM, CPU y crecimiento de WAL. Incorporar gimnasios gradualmente según esas mediciones.

Cambiar a PostgreSQL puede ser útil si se necesita mucha escritura concurrente, varios servidores o gestión central de escalado, pero no arreglaría por sí solo la construcción de snapshots completos ni la multiplicación de respaldos. Primero hay que corregir esos patrones y medir.

## Reproducción y archivos de evidencia

Los artefactos de este equipo están en `output/db-review-2026-11-13/`: `metadata.json`, `benchmark.mjs`, `latest.json`, `synthetic-1794588265137/benchmark.json`, `security-tests.log` y `npm-audit-clean.json`. Contienen únicamente los datos sintéticos de esta revisión y no se agregan al repositorio. El informe conserva las cifras principales aunque esos archivos temporales se retiren.

Comandos ejecutados:

```powershell
node --expose-gc --max-old-space-size=1024 output/db-review-2026-11-13/benchmark.mjs
node --test scripts/check-namecheap.mjs scripts/check-offline-sync.mjs scripts/check-access-policy.mjs scripts/check-login-limit.mjs tests/database.test.ts tests/product-costs.test.ts
npm audit --omit=dev --json
```

Los límites de heap del comando no equivalen a un límite de RAM total del proceso. Se conservaron las bases sintéticas para poder revisar los resultados sin tocar producción. No se ejecutaron cambios de esquema ni mantenimiento sobre bases reales.
