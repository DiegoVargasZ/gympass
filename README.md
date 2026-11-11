# GymPASS 4.8.1

Plataforma para socios, planes, caja y control de acceso. La web, Android y Windows se publican con la misma versión.

## Desarrollo y verificación

Requiere Node.js 24 o posterior.

```sh
npm ci
npm run verify
```

El código fuente web está en `src/`, sus recursos en `public/` y el servidor en `server/`. `npm run build` comprueba TypeScript y genera `dist/`; no edites los archivos compilados. `npm run check` verifica las operaciones del servidor y `npm test` cubre la interfaz y las migraciones.

GitHub Actions compila desde el código versionado, ejecuta las pruebas y entrega ese mismo artefacto al trabajo de despliegue. El servidor de producción instala únicamente las dependencias necesarias para ejecutarse.

## Instalación en Namecheap

1. Configura una aplicación Node.js 24 o posterior, con esta raíz y `app.js` como inicio.
2. Define `PUBLIC_ORIGIN=https://gympass.site` y `GYMPASS_DATA_DIR` con una ruta absoluta persistente fuera de `public_html` y del código desplegado.
3. Ejecuta `npm ci --omit=dev` y reinicia la aplicación en cPanel.
4. Verifica `/api/health` y `/release.json`; este último identifica la versión de la interfaz.

Solo para una instalación nueva:

```sh
node scripts/platform-admin.ts bootstrap --data /ruta/absoluta/a/los/datos
```

No inicialices una plataforma que ya contiene datos. Antes de actualizar, conserva una copia de plataforma y sus claves.

## Publicación

Los cambios de `main` se verifican antes de desplegarse cuando `NAMECHEAP_DEPLOY_ENABLED=true`. Los secretos de SSH y las variables de cPanel se describen en [Operación](docs/OPERACION.md). Android y Windows se distribuyen desde las [entregas oficiales](https://github.com/DiegoVargasZ/gympass/releases).

Se conservan los recursos web de la versión actual y de la inmediatamente anterior para las sesiones abiertas. Las versiones más antiguas se retiran del despliegue público; los instaladores históricos permanecen en GitHub Releases. Consulta [la política de entregas](docs/ENTREGAS.md).

## Uso

El inicio guía al administrador para registrar un socio, crear y cobrar un plan, entregar su QR y registrar la entrada. El QR es permanente; el acceso depende de la vigencia o sesiones del plan pagado. Renovar no cambia la credencial.

Las cuentas de gimnasio entran directamente cuando tienen una sola pertenencia y no muestran el botón para cambiar de gimnasio. El superadministrador conserva el panel de gimnasios y las sesiones de soporte.

Las pantallas antiguas de invitaciones y asistencia laboral están retiradas. Sus rutas históricas quedan disponibles en modo de consulta para administrador y consulta; las operaciones de escritura devuelven HTTP 410. Las bases, migraciones y datos históricos se conservan. Los informes actuales de accesos y horas siguen disponibles.

Más información: [Operación](docs/OPERACION.md), [entregas](docs/ENTREGAS.md), [cambios actuales](docs/CAMBIOS.md) e [historial hasta 4.5.5](docs/HISTORIAL-HASTA-4.5.5.md).
