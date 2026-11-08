# GymPASS para Namecheap

La raíz de este repositorio contiene el código listo para desplegar la plataforma central de GymPASS 4.4.1. La interfaz ya está compilada en `dist/`; el servidor y las migraciones están en `server/`.

Los proyectos locales de escritorio, Android y desarrollo se conservan en el disco y quedan excluidos de Git. Los datos y las credenciales tampoco se versionan.

## Configuración en cPanel

1. Crea o actualiza una aplicación Node.js 24 o posterior. Usa la raíz de este repositorio como raíz de la aplicación y `app.js` como archivo de inicio.
2. Configura `PUBLIC_ORIGIN=https://gympass.site` y `GYMPASS_DATA_DIR` con la ruta absoluta del directorio de datos persistente, fuera de `public_html` y del código que se reemplaza al desplegar.
3. Instala las dependencias con `npm ci --omit=dev` o **Run NPM Install** y reinicia la aplicación desde cPanel.
4. Comprueba `https://gympass.site/api/health`, recarga la página con Ctrl+F5 e inicia sesión.

En una actualización, detén primero la aplicación y respalda sus datos. Conserva la misma ruta `GYMPASS_DATA_DIR`, las bases centrales y de los gimnasios, las fotos y las claves. No inicialices de nuevo una plataforma que ya tiene datos.

Solo para una instalación nueva, crea al propietario desde la terminal del servidor:

```sh
node scripts/platform-admin.ts bootstrap --data /ruta/absoluta/a/los/datos
```

La utilidad pide las credenciales en la terminal. No hay una contraseña predeterminada.

## Compartir la credencial por WhatsApp

El administrador puede pulsar **Enviar por WhatsApp** en **Credenciales QR** o en las credenciales de la ficha del socio. El sistema prepara la imagen PNG del QR activo que ya tiene; no emite ni reemplaza su credencial.

**Descargar PNG y abrir WhatsApp** guarda la tarjeta y abre directamente el chat del número registrado del socio. Adjunta la imagen descargada y confirma el envío en WhatsApp. No hay que elegir el contacto desde un menú del teléfono. El envío automático de una imagen requiere una integración adicional con WhatsApp Business API.

El WhatsApp con código de país es obligatorio al registrar o editar socios y al cobrarles un plan. Las fichas anteriores se conservan; si falta el número, hay que completarlo antes del cobro.

Cada socio conserva su QR al renovar o cambiar de plan, incluso si paga semanas después del vencimiento. El QR identifica al socio; el servidor autoriza la entrada según las fechas de inicio y fin de sus planes vigentes o las sesiones disponibles. Fuera de vigencia no permite entrar, y vuelve a funcionar al comenzar el plan pagado. Si todavía no tiene QR, se crea uno al cobrar su primer plan, junto con la venta en una sola transacción. Reintentar el mismo cobro no duplica pagos ni credenciales. El comprobante permite descargar o compartir la misma tarjeta. Solo una anulación expresa de la credencial obliga a emitir otra; no se reactivan códigos anulados. Se conservan las credenciales NFC y las invitaciones.

## Registrar un socio desde Caja

Al escribir el documento completo de un socio existente, Caja lo selecciona automáticamente y rellena **Nombre del socio**. Las coincidencias parciales o por nombre se eligen en la lista. Cambiar o borrar la búsqueda quita la selección anterior; los socios suspendidos no se seleccionan automáticamente.

Selecciona el plan y busca al socio por nombre o documento en Caja. Si la búsqueda termina sin coincidencias, aparece **Crear socio para este cobro**, que abre el formulario con nombre, documento y WhatsApp obligatorio. Elegir un plan no abre el formulario. **Continuar con el cobro** conserva esos datos y el carrito; el socio, el pago, el plan y su QR se guardan juntos al confirmar el cobro. Cancelar el formulario conserva el carrito y la búsqueda para poder seleccionar un socio existente.

El cajero puede registrar un socio activo dentro de este cobro, con acceso general. Editar fichas o registrar personal y permisos especiales sigue reservado al administrador. Si se pierde la respuesta del pago, reintenta la misma confirmación para recuperar el resultado sin duplicarlo.

Si el socio todavía tiene un plan vigente, Caja muestra **Renovación anticipada** y programa el plan pagado para el día siguiente al último día cubierto. Los días que quedan se conservan: si vence el 10 de noviembre y paga otro mes el día 6, mantiene su acceso hasta el 10 y el nuevo mes comienza el 11. También se respeta el vencimiento de las fichas antiguas y se aplica la misma programación al añadir un plan desde la ficha. No selecciones el reemplazo administrativo si quieres conservar el plan actual; esa opción cancela los días restantes.

Las pantallas antiguas de eventos, invitaciones y asistencia laboral se retiraron de la interfaz. Se conservan las bases, las migraciones y los datos históricos, así como los informes actuales de visitas y horas en el gimnasio.

## Descargar respaldos

Cada administrador de gimnasio puede crear y descargar las copias de **su gimnasio** desde **Configuración → Respaldos**. Se descargan como `.gympassbackup` e incluyen base, fotos, recursos y la clave de recuperación de las credenciales QR. Los cajeros y las cuentas de consulta no tienen este permiso. La restauración de la plataforma sigue reservada al superadministrador.

El superadministrador dispone de **Copia de la plataforma** en su panel. Puede crear una copia y descargar las existentes como `.tar.gz`, con el registro central y los gimnasios. Para restaurarla, se extrae en un directorio nuevo y se utiliza `scripts/platform-restore.ts`. Las copias contienen información privada y deben guardarse en una ubicación de confianza. Se mantiene el límite de descarga de 256 MiB por archivo.

## Escritorio y móviles independientes sin Internet

### Seleccionar la conexión desde Configuración

En Windows 4.5.1, **Configuración → Conexión** ofrece **Servidor y copia automática** y **Copia local de este gimnasio**. Ambos usan la misma base sincronizada: elegir Local ya no abre una base vacía e independiente. Antes de volver al servidor, la aplicación intenta enviar los cambios pendientes; si hay un conflicto o quedan cambios sin enviar, conserva la copia y pide resolverlo antes de cambiar.

La primera ejecución utiliza `https://gympass.site` por defecto. Inicia sesión con una cuenta administradora del gimnasio: GymPASS descarga socios, planes, cobros, credenciales y recursos antes de abrir la gestión. La copia queda guardada para los siguientes arranques y se actualiza automáticamente al reconectar. La base independiente de versiones anteriores se conserva en su carpeta y no se sobrescribe con los datos de otro gimnasio. Una instalación local nueva también muestra este acceso central; el modo independiente avanzado se puede habilitar expresamente con `GYMPASS_STANDALONE=1`.

Desde un navegador, **Abrir conexión** lleva al servidor HTTPS seleccionado o al servidor local que ya esté funcionando en esta computadora. Cada destino requiere su propia sesión. La instalación de escritorio debe estar actualizada para guardar y aplicar la conexión desde esta pantalla.

### Descargar las aplicaciones desde el login

Los formularios de acceso local y de la plataforma incluyen **Descarga GymPASS**, con enlaces directos al APK Android y al instalador Windows de las entregas oficiales de `DiegoVargasZ/gympass`. El login muestra únicamente versiones instalables. Los enlaces se pueden abrir sin iniciar sesión y los binarios se alojan en GitHub Releases.

La web conserva el logo horizontal anterior y el panel de bienvenida negro. El login muestra el formulario y las descargas sin desplazamiento vertical en pantallas de escritorio de 1980 × 1080 y 1920 × 1080. Los instaladores 4.4.1 mantienen los nuevos iconos de Windows y Android; Windows permite guardar la conexión desde Configuración.

Usa **Windows 4.5.1 y Android 4.5.1** y realiza la primera vinculación con Internet. Cada dispositivo conserva su propia copia del gimnasio y sincroniza automáticamente al recuperar la conexión. La computadora puede estar apagada cuando se utiliza un móvil conectado directamente a la plataforma o su copia sin conexión.

- **Windows:** instala 4.5.1 y entra con la cuenta administradora del gimnasio. La primera conexión prepara automáticamente la copia completa. Configuración → Conexión permite elegir Servidor o Copia local sin cambiar de base. Al reconectar se envían los cambios y se reciben los de otros equipos. La instalación independiente anterior se conserva aparte.
- **Android:** instala el APK 4.5.1. **Gestión** abre directamente `https://gympass.site/` con el mismo login, diseño claro, apartados y funciones de la web, según los permisos de la cuenta. Funciona en vertical y horizontal. La gestión completa requiere Internet. Para preparar la copia local, abre **Lector sin conexión**, inicia sesión allí con Internet y selecciona el gimnasio si tienes varios. El lector, los socios, la presencia, el historial reciente y las horas funcionan después sin Wi-Fi, datos ni computadora. Cada teléfono tiene su propio archivo SQLite, separado por servidor, gimnasio y cuenta. El historial móvil conserva los últimos 10.000 movimientos y las entradas abiertas necesarias para calcular la presencia.

Android 4.5.1 abre automáticamente **Lector sin conexión** con la última cuenta que ingresó en ese lector. Recupera su sesión y copia local sin esperar a la web ni volver a pedir la contraseña. La primera vinculación requiere Internet; **Salir** cierra expresamente la sesión y permite cambiar de cuenta. Si falla la recuperación local, muestra **Reintentar** y conserva la cuenta guardada. Se mantiene la autorización de 7 días desde la última sincronización. Instala el APK sobre la versión anterior sin desinstalar para conservar los datos.

La corrección 4.5.1 pasó las 57 pruebas móviles y TypeScript, incluida la recuperación de cuenta, el cambio de usuario y la conservación de accesos SQLite al reiniciar sin red. El APK firmado pasó dos arranques en frío hasta el login web y la apertura del login nativo del lector en un emulador Android 17 con páginas de 16 KiB. Conserva paquete, versión de compilación 4501 y certificado de firma. No se ha probado en un teléfono físico.

Android 4.5.0 conserva el paquete y la firma de 4.4.2: instala la actualización sobre la anterior para conservar los datos. Pasó 51 pruebas móviles, TypeScript, dos arranques en frío hasta el login real y la rotación vertical/horizontal/vertical en un emulador Android 17 con páginas de 16 KiB. Las descargas, el uso compartido de archivos y la impresión se integran con Android. No se ha probado en un teléfono físico.

Android 4.4.2 corrige el cierre al abrir que producía `Cannot find native module 'ExpoSQLite'` en 4.4.1. El proyecto móvil fija `expo-sqlite` en 58.0.10 para conservar la integración nativa anterior a su migración a Modules v2. Se mantiene el paquete, la firma y la ubicación de los datos: instala la actualización sobre la anterior, sin desinstalar ni borrar sus datos. El APK firmado pasó dos arranques en frío en un emulador Android 17 con páginas de 16 KiB, además de las pruebas móviles y TypeScript.

Antes de publicar otro APK, ejecuta `node scripts/check-android-start.mjs /ruta/GymPASS-Android-VERSION.apk emulator-5554`. El script instala únicamente en un emulador, comprueba el login tras dos aperturas y registra la huella del archivo probado. El publicador Android requiere esa comprobación para el mismo APK y no altera su firma.
- **Administración central:** **Configuración → Conexión** muestra los dispositivos, su última sincronización y los lotes que necesitan revisión. Puedes revocar o reactivar una vinculación. El superadministrador también puede administrarlas dentro de una sesión de soporte, pero la primera vinculación se hace con una cuenta propia del gimnasio.

Las autorizaciones sin conexión duran **7 días desde la última sincronización**; las fechas y sesiones de los planes se siguen comprobando en la copia local. Al reconectar se comprueban de nuevo gimnasio, cuenta, rol y vinculación. La suspensión o baja del gimnasio y la revocación de permisos bloquean nuevas sincronizaciones. Cambiar la contraseña central invalida las vinculaciones anteriores.

Sin conexión, los dispositivos conocen las altas, bajas y pagos que recibieron en su última copia. Dos equipos desconectados pueden tomar decisiones incompatibles sobre aforo, presencia o la última sesión de un socio. Al reconectar, el servidor conserva esos lotes para revisión y no reemplaza silenciosamente los datos centrales ni permite que los contadores queden negativos. El administrador puede **Descargar pendientes**, revisar sus respaldos y elegir **Conservar nube y archivar lote local**. Antes de reemplazar un lote archivado, escritorio conserva un respaldo local y móvil conserva el lote en su archivo. La operación de archivar no registra cobros adicionales: cualquier ajuste comercial se revisa expresamente.

Las altas y pagos usan identificadores estables. Un envío confirmado cuya respuesta se pierde se puede repetir sin duplicar los datos, y las operaciones posteriores se conservan mientras se confirma el lote anterior. Se combinan cambios compatibles de distintos campos; las ediciones incompatibles del mismo dato se conservan como conflicto. Los movimientos se ordenan por su fecha real, no por el momento en que llegaron al servidor. El QR permanente se conserva al sincronizar y renovar.

El móvil solo recibe la información necesaria para recepción y consultas; no descarga las contraseñas centrales, las claves de los lectores, los importes de ventas ni los códigos QR descifrables. Las copias completas de escritorio requieren una cuenta administradora. El mínimo de contraseña se mantiene en **6 caracteres**.

## Encuadrar la foto de un socio

Al cargar una imagen o capturar una foto, arrástrala dentro de la vista previa con el ratón o el dedo para ajustar el encuadre. Acerca o aleja sobre la propia foto con la rueda del ratón o separando y juntando dos dedos. También puedes enfocarla con el teclado y usar las flechas para mover y + / - para acercar o alejar. El recorte respeta los bordes de la imagen y se guarda como una copia cuadrada de 512 × 512 px.

## Cierre diario y acceso automático

En escritorio, la distribución aprovecha pantallas de **1920 × 1080 y 1980 × 1080**. Recepción ajusta la altura de la cámara para mostrarla completa junto con sus controles; la presencia y los movimientos continúan debajo. Caja mantiene visible la confirmación del cobro y desplaza los catálogos largos dentro de sus listas. El historial del socio se puede desplegar sin sacar el botón de cobro de la pantalla. Planes conserva sus herramientas y cabecera al recorrer la lista. En Configuración, Mi gimnasio presenta los datos y el cierre automático en dos columnas para mostrar el formulario y su submenú completos.

En **Configuración → Datos del gimnasio → Cierre automático**, selecciona **A la hora de cierre del gimnasio**, indica la hora y guarda. Se utiliza la **Zona horaria** de ese gimnasio: para cerrar a las 23:00 en Bolivia, elige **Bolivia (La Paz)** y **23:00**. La hora no se activa por defecto en otros gimnasios.

El sistema revisa los cierres cada minuto y registra las salidas pendientes con la hora de cierre configurada. Los informes las muestran como **Salida estimada**. Si el servidor estuvo detenido, al volver recupera el primer cierre que correspondía a cada visita. Una entrada registrada exactamente en el límite o después corresponde al siguiente cierre. Las salidas reales anteriores se conservan y los reintentos no duplican movimientos. También puedes conservar el cierre por horas o desactivarlo.

En Recepción, **Acceso automático** abre la pantalla para cámara o lector USB. Cada lectura alterna entrada y salida según si la persona está dentro; ya no hay que elegir el movimiento. Los lectores USB deben enviar **Enter** al terminar el código. Se conservan las configuraciones de los equipos externos con entradas o salidas dedicadas.

En la plataforma web, abrir **Acceso automático** restringe esa sesión en el servidor al lector del gimnasio. Cambiar la dirección, recargar o abrir otra pestaña con la misma sesión mantiene esa restricción. **Salir** cierra la sesión; para volver al panel hay que iniciar sesión con correo y contraseña. El PIN local deja de utilizarse en la plataforma. El mínimo de contraseña sigue siendo **6 caracteres**.

Los cajeros pueden usar Recepción, Caja y las consultas de la aplicación lectora móvil. Los informes históricos y sus exportaciones requieren administrador o consulta también en el servidor.

Las fichas nuevas de socios pueden registrarse sin cobrar, pero su QR no autoriza entradas hasta tener un plan vigente. La migración conserva los derechos heredados de las fichas existentes y el QR permanente. Un vencimiento escrito en una ficha nueva no sustituye el plan.

## Conectar lectores

Entra como administrador en **Configuración → Lectores**. Puedes preparar las conexiones antes de tener el equipo. Hay dos formas de usar un lector:

### USB que funciona como teclado

1. Conecta el lector QR o de tarjeta a la computadora e instala el controlador que indique su fabricante.
2. En la configuración del lector selecciona **teclado USB / HID** y añade **Enter** al final de cada lectura.
3. Pulsa **Abrir Recepción con lector** y deja enfocado el campo **Código de credencial**. El lector escribe el código y Enter confirma el movimiento.
4. Prueba la credencial de un socio y comprueba su nombre y el resultado. Para una tarjeta NFC, vincula primero el identificador exacto a ese socio.

Este modo utiliza la sesión del recepcionista y no necesita una clave de equipo. Un USB que sólo funciona mediante el SDK del fabricante necesita un conector; conectar su cable no lo convierte en teclado.

### Equipo por red o programa del fabricante

1. En Lectores, elige **Equipo por red o programa externo**.
2. Indica nombre, tipo (QR, NFC o biometría), movimiento (entrada, salida o alternar) y zona. Pulsa **Crear conexión**.
3. Guarda el archivo JSON con **Guardar configuración**. Incluye las direcciones del gimnasio y la clave del equipo; esa clave no se recupera de la lista después de cerrar. **Ver conexión** permite volver a consultar las direcciones y pegar una clave guardada. Si la pierdes, revoca esa conexión y crea otra.
4. **Comprobar conexión** valida la clave y el servidor. No registra entradas ni salidas y no actualiza **Última lectura**. Después hay que probar una lectura real desde el equipo.
5. Configura el lector o su programa para enviar las solicitudes descritas abajo. Si el equipo sólo se comunica con un SDK propio, el instalador debe adaptar ese SDK a esta API. El archivo JSON reúne los datos de conexión; no instala un controlador ni configura automáticamente cualquier modelo.

Para NFC: en **Socios → Credencial QR**, elige **Tarjeta NFC** y guarda exactamente el identificador leído. Para huella: registra la huella con el equipo o software del fabricante, anota el identificador que devuelve al reconocer al usuario y guárdalo en la credencial **Identificador biométrico externo** del socio. El identificador admite entre 4 y 200 caracteres; si el SDK usa números más cortos, el conector puede usar un prefijo, por ejemplo `bio:42`, tanto al vincularlo como al enviarlo. GymPASS recibe ese identificador, no captura ni compara huellas. El QR mensual y la credencial biométrica son independientes.

### Datos para el instalador

Las direcciones exactas aparecen en pantalla y en el JSON descargado. En la plataforma son:

```text
GET  https://gympass.site/api/gyms/ID_DEL_GIMNASIO/device-check
POST https://gympass.site/api/gyms/ID_DEL_GIMNASIO/device-access
Authorization: Bearer CLAVE_DEL_LECTOR
Content-Type: application/json
```

El GET de comprobación devuelve `ok: true` y los datos del lector autorizado. No requiere una sesión de usuario. Una clave inválida, revocada o de otro gimnasio se rechaza. Un gimnasio suspendido, archivado o dado de baja tampoco acepta la comprobación ni las lecturas, incluso si la solicitud ya estaba esperando su turno.

Cada lectura envía un JSON como este (el programa genera un UUID distinto para cada lectura):

```json
{
  "code": "bio:42",
  "request_id": "f5617cb2-9854-4d50-b9e2-c7ba46e1a40d"
}
```

El valor `code` es el QR completo o el identificador NFC/biométrico vinculado al socio. Reintentar la misma lectura debe conservar su `request_id` para no duplicar el movimiento. La zona, el método y la dirección se toman del lector registrado.

La respuesta indica `allowed`, `reason`, `message`, `event_id` y `person_name`. Sólo `allowed: true` autoriza el acceso: un HTTP 200 también puede devolver una denegación por plan vencido, socio suspendido u otra regla. El equipo o conector gestiona la apertura física del torniquete; la comprobación de conexión no lo acciona. Antes de usar la apertura real, comprueba lecturas permitidas, denegadas y errores de red con el equipo concreto.

En una instalación local se utilizan las mismas rutas sin `/gyms/ID_DEL_GIMNASIO`, bajo la dirección de ese servidor. Un lector que envía al dominio necesita salida a Internet. Un equipo que sólo está en la red local necesita su programa o conector en esa red para enviar las solicitudes al dominio.

## Despliegue automático desde GitHub

La interfaz carga las pantallas bajo demanda. Inicio solicita `bootstrap?compact=1`, que conserva sus estadísticas y evita calcular gráficos históricos que no se muestran allí. Los archivos públicos compilados conservan Brotli/gzip, caché del navegador y una caché de memoria limitada a 16 MB en el servidor.

Las sesiones abiertas reciben avisos por WebSocket en `wss://gympass.site/api/gyms/ID_DEL_GIMNASIO/realtime`. El canal utiliza la cookie de sesión, comprueba origen y permisos y solo comunica qué datos cambiaron en ese gimnasio; los cobros y las lecturas mantienen sus rutas HTTP e identificadores de reintento. Agrupa ráfagas, reconecta tras cortes y pausa al ocultar la pestaña. Mientras está conectado reemplaza el sondeo de 30 segundos; si el proxy no permite WebSocket, conserva ese sondeo como respaldo. Una revisión cada cinco minutos contempla vencimientos por fecha sin movimientos.

Después de publicar, `npm run check:realtime-host` comprueba, sin credenciales y sin modificar datos, que el hosting entrega el encabezado Upgrade a Node.js. El resultado correcto es un rechazo 401 identificado por `X-GymPASS-Realtime: websocket`. Si falla, el proveedor debe habilitar el proxy WebSocket hacia la aplicación Node.js para esta ruta, conservar `Origin`, cookies y `Sec-WebSocket-Protocol`, y permitir conexiones persistentes. En LiteSpeed/cPanel esto puede requerir configuración del virtual host por parte del proveedor: [documentación oficial](https://docs.litespeedtech.com/lsws/cp/cpanel/websocket-proxy/).

El workflow `.github/workflows/verify.yml` instala las dependencias y comprueba el arranque, la interfaz, la protección de origen y la recuperación de bases anteriores. Los cambios de `main` se pueden desplegar por SSH tras superar esas comprobaciones.

Configura estos secretos en **Settings → Secrets and variables → Actions** del repositorio:

| Secreto                 | Valor                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `NAMECHEAP_HOST`        | Servidor SSH de Namecheap.                                         |
| `NAMECHEAP_USER`        | Usuario de cPanel.                                                 |
| `NAMECHEAP_SSH_KEY`     | Clave privada de despliegue autorizada en cPanel.                  |
| `NAMECHEAP_KNOWN_HOSTS` | Claves públicas verificadas del servidor en formato `known_hosts`. |
| `NAMECHEAP_APP_ROOT`    | Ruta absoluta de la aplicación Node.js.                            |
| `NAMECHEAP_NODE_ENV`    | Archivo `bin/activate` del entorno Node.js que muestra cPanel.     |

En **Variables**, `NAMECHEAP_PORT` indica el puerto SSH (predeterminado: 21098). La variable `NAMECHEAP_DEPLOY_ENABLED` controla el despliegue: con `false` se ejecutan las comprobaciones; con `true`, los siguientes cambios de `main` se publican automáticamente. También se puede ejecutar **Actions → Verificar y desplegar Namecheap → Run workflow** sobre `main`.

El script conserva una copia del código anterior en `~/gympass-code-backups`, actualiza los archivos sin eliminar datos ni configuración de cPanel, instala las dependencias dentro del entorno Node.js y solicita el reinicio con `tmp/restart.txt`. En LiteSpeed también cierra mediante SIGTERM únicamente los procesos `lsnode` de la misma cuenta cuya carpeta de trabajo coincida exactamente con esta aplicación. Al terminar comprueba `https://gympass.site/api/health` y su encabezado de capacidad de tiempo real para detectar servidores que sigan ejecutando código anterior. Las bases, las fotos y las claves de los gimnasios permanecen en su directorio persistente.

La carpeta `dist/` contiene una interfaz ya compilada. Para cambiarla, prepara la nueva compilación del proyecto local y actualiza sus archivos antes de subir a `main`; GitHub no necesita instalar Electron ni compilar Android.

Referencias: [Node.js en Namecheap](https://www.namecheap.com/support/knowledgebase/article.aspx/10047/2182/how-to-work-with-nodejs-app/) y [reinicio de Passenger en cPanel](https://support.cpanel.net/hc/en-us/articles/1500002443862-How-to-restart-an-application-that-s-using-cPanel-s-Application-Manager).
