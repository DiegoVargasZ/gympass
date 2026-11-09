# Cambios

## 4.5.7

- Restaurados los módulos de cámara QR actuales y anteriores. Se entregan todos los archivos emitidos por Vite y se prueban las importaciones entre comillas invertidas y la decodificación real de una imagen QR.
- La sincronización de escritorio deja libre la copia local mientras espera a Internet. Conserva las ediciones y cobros hechos durante una descarga o confirmación pendiente; cerrar cancela la espera y conserva el lote para reintentar.
- La carga del panel y la comprobación de cierres automáticos comparten correctamente la cola, sin esperar una tarea que está detrás de la petición actual.
- Corregido el aviso de conexión de escritorio para no pedir que dos equipos estén en la misma red Wi-Fi.
- Android y Windows actualizados a 4.5.7, conservando identidad y datos.

## 4.5.6

- Login aislado por cuenta, sin bloqueo compartido entre usuarios detrás del proxy. Cuenta fallos, protege intentos simultáneos y admite proxies confiables configurados.
- Inicio en cuatro pasos, incluyendo creación y cobro del plan antes de usar el QR.
- Retirado el cambio de gimnasio de las cuentas normales; el superadministrador conserva el soporte.
- Fuente web y dependencias de compilación versionadas. GitHub verifica tipos, compila y despliega el artefacto probado.
- Retención de la interfaz actual y la anterior; retirada de recursos y descargas antiguas del directorio público.
- Módulos antiguos disponibles solo para consulta histórica autorizada; sus escrituras devuelven 410. Se conservan datos y migraciones.
- Los informes actuales de accesos y sus consultas guardadas siguen disponibles.
- Documentación de instalación, operación e historial separada.
- Android y Windows actualizados a 4.5.6.

El historial anterior se conserva en [HISTORIAL-HASTA-4.5.5.md](HISTORIAL-HASTA-4.5.5.md).
