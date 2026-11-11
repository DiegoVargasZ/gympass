# Operación de GymPASS

## Configuración del servidor

| Variable | Uso |
| --- | --- |
| `PUBLIC_ORIGIN` | Origen HTTPS exacto, por ejemplo `https://gympass.site`. |
| `GYMPASS_DATA_DIR` | Directorio persistente absoluto, fuera de `public_html` y del código. |
| `PORT` | Puerto asignado por cPanel. |
| `GYMPASS_MAX_OPEN` | Máximo de gimnasios abiertos simultáneamente; predeterminado 32. |
| `GYMPASS_TRUSTED_PROXIES` | IP o redes CIDR de proxies confiables, separadas por comas; vacío por defecto. |

La protección del login cuenta fallos por cuenta normalizada y por combinación de cuenta y cliente. Web y móvil comparten el límite de 30 intentos fallidos en 15 minutos. Los accesos correctos no consumen el cupo. Los intentos simultáneos también se reservan y las respuestas 429 incluyen `Retry-After`.

`X-Forwarded-For` se ignora cuando la conexión no viene de un proxy configurado. La cadena se recorre de derecha a izquierda hasta el primer salto no confiable. Configura únicamente las direcciones verificadas con el proveedor y asegúrate de que el proxy sobrescribe o añade correctamente la dirección real. No uses una red abierta como `0.0.0.0/0`. La corrección de aislamiento entre cuentas funciona también con la configuración vacía.

## Despliegue automático

En GitHub Actions deben existir los secretos `NAMECHEAP_HOST`, `NAMECHEAP_USER`, `NAMECHEAP_SSH_KEY`, `NAMECHEAP_KNOWN_HOSTS`, `NAMECHEAP_APP_ROOT` y `NAMECHEAP_NODE_ENV`. Verifica las claves SSH del servidor antes de guardarlas.

Las variables son `NAMECHEAP_PORT` (21098 por defecto) y `NAMECHEAP_DEPLOY_ENABLED` (`true` habilita el despliegue de `main`). El workflow instala con el lockfile, verifica tipos, compila, ejecuta las pruebas y transfiere el artefacto verificado. Conserva una copia del código anterior en `~/gympass-code-backups`.

El directorio público `dist/` se sincroniza con eliminación de archivos obsoletos. Los datos, fotos privadas, bases y configuración de cPanel deben estar fuera de ese directorio. El resto de la aplicación se sincroniza sin eliminar datos.

Tras publicar, comprueba `/api/health`, `/release.json` y el login. `npm run check:realtime-host` verifica si el hosting permite WebSocket; el sondeo HTTP permanece como respaldo.

## Respaldos y actualización

El administrador descarga la copia de su gimnasio desde **Configuración → Respaldos**. El superadministrador crea y descarga una copia completa desde **Copia de plataforma**. Guarda además una copia fuera del hosting.

Para recuperar una copia descargada de un gimnasio, abre **Configuración → Respaldos → Usar respaldo descargado** y selecciona el archivo `.gympassbackup` del mismo gimnasio. Importar verifica el archivo y lo agrega a la lista sin cambiar los datos actuales. Para aplicarlo, el superadministrador debe entrar en modo soporte, confirmar la restauración con su contraseña y conservar la copia previa que crea GymPASS.

Para restaurar la plataforma, extrae el `.tar.gz` en un directorio nuevo y utiliza `scripts/platform-restore.ts`. Conserva las claves y fotos junto a las bases. No modifiques ni elimines migraciones publicadas ni reduzcas `schema_version`.

## Aplicaciones y trabajo sin conexión

Instala Android y Windows 4.7.0 desde las entregas oficiales. Actualiza Android sobre la instalación existente para conservar cuenta y pendientes. Se mantiene el paquete y la firma. La primera vinculación necesita Internet; la autorización sin conexión dura siete días desde la última sincronización.

En Windows, Configuración → Conexión permite utilizar servidor o copia local sincronizada. En Android, Gestión utiliza la web y requiere Internet; Lector sin conexión conserva su copia autorizada. Los conflictos se revisan antes de reemplazar datos locales. Windows sigue la política existente de distribución sin firma de código.

El instalador Windows 4.7.0 conserva Electron 45 y requiere Windows 10 o posterior, en equipos x64. La compatibilidad web con Chrome/Edge 109 no amplía los sistemas admitidos por ese instalador. [Electron retiró Windows 7, 8 y 8.1 desde su versión 23](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice).

## Recepción y caja

En **Configuración → Apariencia** elige una de las diez voces de GymPASS o una voz del dispositivo y ajusta la velocidad entre 50 % y 300 %. Puedes probar entrada o salida antes de pulsar **Guardar cambios**. El navegador descarga el modelo compartido una vez (alrededor de 110 MB), sintetiza los nombres localmente y reutiliza los últimos avisos de esa sesión. Si la voz está cargando o no se puede reproducir, recepción usa la voz del dispositivo o el tono de confirmación.

Registra al socio con su WhatsApp, crea un plan y confirma el cobro. El primer pago crea su QR permanente de forma atómica; los reintentos no duplican el cobro. La fecha inicial del plan determina cuándo puede entrar. Comparte la credencial existente desde la ficha o comprobante.

Un lector USB debe funcionar como teclado y terminar cada lectura con Enter. Un lector de red utiliza la clave de dispositivo y las rutas mostradas en Configuración → Lectores. Una respuesta HTTP 200 no basta para abrir: el conector debe exigir `allowed: true`.

El cierre automático se configura con la zona horaria del gimnasio. Las salidas recuperadas se identifican como estimadas. Los informes de accesos y horas permanecen operativos.
