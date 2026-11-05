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
