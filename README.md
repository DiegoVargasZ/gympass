# GymPASS para Namecheap

La raíz de este repositorio contiene el código listo para desplegar la plataforma central de GymPASS 4.3.0, incluida la corrección de apertura de bases existentes. La interfaz ya está compilada en `dist/`; el servidor y las migraciones están en `server/`.

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

Cada pago de un plan mensual genera automáticamente una nueva credencial QR y anula el QR anterior del socio. La credencial y la venta se guardan juntas: un reintento del mismo cobro no genera otra clave ni duplica el pago. El comprobante permite preparar la tarjeta y abrir su WhatsApp. Se conservan las credenciales NFC y las invitaciones.

## Registrar un socio desde Caja

Selecciona el plan y busca al socio por nombre o documento en Caja. Si la búsqueda termina sin coincidencias, aparece **Crear socio para este cobro**, que abre el formulario con nombre, documento y WhatsApp obligatorio. Elegir un plan no abre el formulario. **Continuar con el cobro** conserva esos datos y el carrito; el socio, el pago, el plan y su QR se guardan juntos al confirmar el cobro. Cancelar el formulario conserva el carrito y la búsqueda para poder seleccionar un socio existente.

El cajero puede registrar un socio activo dentro de este cobro, con acceso general. Editar fichas o registrar personal y permisos especiales sigue reservado al administrador. Si se pierde la respuesta del pago, reintenta la misma confirmación para recuperar el resultado sin duplicarlo.

Las pantallas antiguas de eventos, invitaciones y asistencia laboral se retiraron de la interfaz. Se conservan las bases, las migraciones y los datos históricos, así como los informes actuales de visitas y horas en el gimnasio.

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

El GET de comprobación devuelve `ok: true` y los datos del lector autorizado. No requiere una sesión de usuario. Una clave inválida, revocada o de otro gimnasio se rechaza. Un gimnasio suspendido tampoco acepta la comprobación ni las lecturas.

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

El script conserva una copia del código anterior en `~/gympass-code-backups`, actualiza los archivos sin eliminar datos ni configuración de cPanel, instala las dependencias dentro del entorno Node.js y solicita el reinicio con `tmp/restart.txt`. Al terminar comprueba `https://gympass.site/api/health`. Las bases, las fotos y las claves de los gimnasios permanecen en su directorio persistente.

La carpeta `dist/` contiene una interfaz ya compilada. Para cambiarla, prepara la nueva compilación del proyecto local y actualiza sus archivos antes de subir a `main`; GitHub no necesita instalar Electron ni compilar Android.

Referencias: [Node.js en Namecheap](https://www.namecheap.com/support/knowledgebase/article.aspx/10047/2182/how-to-work-with-nodejs-app/) y [reinicio de Passenger en cPanel](https://support.cpanel.net/hc/en-us/articles/1500002443862-How-to-restart-an-application-that-s-using-cPanel-s-Application-Manager).
