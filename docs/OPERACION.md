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

## Avisos a los gimnasios

En el panel del superadministrador, cada tarjeta muestra **Socios registrados**. El número incluye socios activos, inactivos y con plan vencido; excluye personal y socios eliminados. Se vuelve a consultar al pulsar **Actualizar gimnasios** y al regresar al listado. También aparece al consultar gimnasios archivados o dados de baja. **No disponible** indica que no pudo leerse una base, y se distingue de un gimnasio con cero socios. Las cuentas de gimnasio no reciben estos totales centrales.

El superadministrador envía un aviso desde el panel de gimnasios, en **Avisos**: un título, el mensaje, su importancia, los días que permanece visible y los gimnasios que lo reciben (todos o una selección). Llega a la campana de alertas de cada gimnasio junto a sus propias alertas y se distingue con el icono de megáfono.

El aviso desaparece solo al cumplirse el plazo; **Retirar** lo quita antes y conserva el registro. Marcarlo como leído solo apaga el distintivo de quien lo leyó. Los avisos se consultan contra el servidor: las copias locales sin conexión de Windows y Android no los muestran hasta volver a conectarse.

## Respaldos y actualización

Solo el superadministrador administra respaldos. Desde su panel, pulsa **Respaldos** en la tarjeta de cada gimnasio para crear, consultar y descargar sus copias. **Copia de plataforma** conserva la copia completa del registro central y los gimnasios. Guarda además una copia fuera del hosting.

Para recuperar una copia descargada, el superadministrador abre **Respaldos → Usar respaldo descargado** en la tarjeta del gimnasio y selecciona su archivo `.gympassbackup`. Importar verifica el archivo sin cambiar los datos actuales; restaurar exige escribir RESTAURAR y confirmar la contraseña del superadministrador. GymPASS crea una copia previa. Las cuentas de gimnasio y las aplicaciones locales no administran respaldos.

Para restaurar la plataforma, extrae el `.tar.gz` en un directorio nuevo y utiliza `scripts/platform-restore.ts`. Conserva las claves y fotos junto a las bases. No modifiques ni elimines migraciones publicadas ni reduzcas `schema_version`.

Desde el servidor 5.3.1, la plataforma crea una copia completa diaria y conserva 14. Ese calendario sustituye la creación diaria adicional de copias individuales de cada gimnasio. Las copias individuales existentes, manuales y previas a restauraciones se conservan. Los recursos que no cambiaron se pueden compartir mediante enlaces físicos entre respaldos inmutables; los archivos activos se mantienen independientes de esos respaldos. En sistemas sin soporte de enlaces físicos se copia el archivo.

Las descargas y la importación web admiten hasta 4 GiB y procesan los archivos por partes. El servidor reserva espacio para recibir y extraer la copia, conserva un margen libre y limpia temporales ante desconexiones o errores. Las subidas autorizadas tienen un plazo máximo de 30 minutos; el proxy del hosting puede imponer un límite menor. La descarga de un respaldo individual no ocupa la cola de la base activa del gimnasio. Crear una copia global todavía pausa las operaciones de gimnasios durante la captura coherente; los hashes y las copias pesadas se ejecutan en un trabajador separado y el servidor sigue atendiendo salud/autenticación.

La descarga central se entrega al gestor del navegador para guardarla en disco sin cargar un Blob completo en JavaScript. Se abre en otra pestaña para conservar el panel y mostrar un error legible si la sesión dejó de ser válida; el nombre lo proporciona el servidor.

Hay un cupo global para transferencias pesadas. Una respuesta 429 con `Retry-After: 5` pide reintentar; no borra los cambios offline ni crea cobros duplicados. El almacenamiento externo automático no está configurado por esta entrega: descarga una copia a otro equipo/cuenta, protégela y comprueba que puedes restaurarla. Los respaldos descargados siguen siendo archivos privados sin cifrado integral.

## Aplicaciones y trabajo sin conexión

Instala Android y Windows 5.3.0 desde las entregas oficiales. Actualiza Android sobre la instalación existente para conservar cuenta y pendientes. Se mantiene el paquete y la firma. La primera vinculación necesita Internet; la autorización sin conexión dura siete días desde la última sincronización.

En Windows, Configuración → Conexión permite utilizar servidor o copia local sincronizada. En Android, Gestión incluye una copia local para administradores y sincroniza automáticamente al reconectar; el lector conserva su copia autorizada para recepción. Consulta la [guía móvil sin conexión](MOVIL-SIN-CONEXION.md). Los conflictos se revisan antes de reemplazar datos locales. Windows sigue la política existente de distribución sin firma de código.

El instalador Windows 5.3.0 conserva Electron 45 y requiere Windows 10 o posterior, en equipos x64. La compatibilidad web con Chrome/Edge 109 no amplía los sistemas admitidos por ese instalador. [Electron retiró Windows 7, 8 y 8.1 desde su versión 23](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice).

## Recepción y caja

En **Configuración → Avisos y sonidos** activa **Reproducir avisos de entrada y salida** y selecciona **Audios de acceso permitido y denegado** para usar las grabaciones proporcionadas. Un escaneo válido anuncia «Acceso permitido», tanto de entrada como de salida, y un código ajeno o vencido anuncia «Acceso denegado»; Android los incluye para Recepción sin Internet. Puedes probar ambos antes de pulsar **Guardar cambios**. También siguen disponibles las diez voces de GymPASS y las voces del dispositivo, con velocidad entre 50 % y 300 % y lectura del nombre. Las grabaciones mantienen su velocidad original. Si un audio no se puede cargar, se usa el tono de confirmación.

Registra al socio con su WhatsApp, crea un plan y confirma el cobro. El primer pago crea su QR permanente de forma atómica; los reintentos no duplican el cobro. La fecha inicial del plan determina cuándo puede entrar. Comparte la credencial existente desde la ficha o comprobante. **Enviar por WhatsApp** abre el chat del socio con un enlace privado a su tarjeta (WhatsApp la muestra como vista previa). El enlace vence a los 7 días, se reemplaza al crear otro y deja de funcionar si se anula la credencial; las imágenes se guardan en la carpeta `shares` del gimnasio, que no entra en los respaldos.

No hace falta guardar al socio en la agenda: el chat se abre con su número internacional. Windows intenta abrir WhatsApp instalado y utiliza el navegador si el sistema no puede abrir la aplicación. Confirma el envío dentro de WhatsApp.

Después de activarla, la cámara de recepción sigue habilitada al navegar por las pantallas de gestión, elegir otro método de registro o cambiar de pestaña. Para detenerla, pulsa **Apagar cámara** o cierra la sesión. Si el sistema termina la captura, el lector intenta recuperarla al regresar. El navegador y el sistema operativo pueden suspender la captura o limitar las lecturas en segundo plano.

Un lector USB debe funcionar como teclado y terminar cada lectura con Enter. Un lector de red utiliza la clave de dispositivo y las rutas mostradas en Configuración → Lectores. Una respuesta HTTP 200 no basta para abrir: el conector debe exigir `allowed: true`.

El cierre automático se configura con la zona horaria del gimnasio. Las salidas recuperadas se identifican como estimadas. Los informes de accesos y horas permanecen operativos.

## Costos y ganancias de productos

En **Caja y planes → Productos**, registra el costo de compra por unidad y el precio de venta en BOB. El formulario muestra su diferencia como ganancia bruta por unidad y avisa si vendes por debajo del costo. El campo código/SKU ya no aparece; los códigos anteriores se conservan internamente.

En **Informes**, consulta los ingresos por productos, el costo de los productos vendidos y la ganancia bruta, también en CSV o al imprimir/guardar PDF. El costo se guarda al cobrar cada venta: editar el producto no recalcula las ventas anteriores. Las ventas anuladas se excluyen. Esta ganancia no incluye planes ni descuenta alquiler, sueldos u otros gastos del gimnasio.

Los productos y ventas anteriores sin costo muestran **Sin registrar**. Registrar un costo ahora sirve para las ventas nuevas; los reportes anteriores mantienen ese costo desconocido e indican las unidades pendientes y los importes parciales. Un costo cero indica expresamente que la unidad no tuvo costo.

La gestión sin conexión guarda los mismos costos e históricos. Actualiza las aplicaciones a 5.3.0 para usar estos campos; las versiones anteriores siguen sincronizando sus datos sin borrar los costos registrados en la web.

El servidor 5.3.1 mantiene ese mismo protocolo y funciona con los instaladores 5.3.0 publicados. Cuando no cambió la información, comprueba la revisión y renueva permisos sin recorrer todas las filas ni leer imágenes. Cuando hay cambios, envía la instantánea completa por flujo: esta entrega no introduce un protocolo nuevo de diferencias entre filas. Las descargas utilizan una lectura SQLite coherente sin impedir entradas y cobros simultáneos; se limita su duración para no retener el WAL indefinidamente.

## Apariencia compartida

Tema, color de acento y densidad se configuran por gimnasio desde Apariencia. Los cambios de un administrador llegan a los otros dispositivos al sincronizar. Android y Windows reintentan la conexión cada diez segundos mientras se ejecutan. Consulta [Apariencia por gimnasio](APARIENCIA-POR-GIMNASIO.md).

Los respaldos se administran exclusivamente con una cuenta de superadministrador, desde el panel central y el botón Respaldos de cada gimnasio. No se ofrecen a las cuentas administradoras del gimnasio.
