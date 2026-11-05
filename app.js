import { resolve } from 'node:path';
import { startPlatform } from './server/platform.ts';

// lsnode carga con require(): el arranque debe conservar un grafo sin top-level await.
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1) throw Error('PORT inválido.');
if (!process.env.PUBLIC_ORIGIN) throw Error('Configura PUBLIC_ORIGIN con la URL HTTPS de la aplicación.');
if (!process.env.GYMPASS_DATA_DIR) throw Error('Configura GYMPASS_DATA_DIR fuera de public_html.');

startPlatform({
  dataDirectory: resolve(process.env.GYMPASS_DATA_DIR),
  port,
  host: '127.0.0.1',
  publicOrigin: process.env.PUBLIC_ORIGIN,
  maxOpen: Number(process.env.GYMPASS_MAX_OPEN || 32),
})
  .then((app) => {
    console.log('GymPASS plataforma:', process.env.PUBLIC_ORIGIN);
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => void app.close().then(() => process.exit(0)));
  })
  .catch((error) => {
    console.error('GymPASS no pudo arrancar:', error);
    process.exitCode = 1;
  });
