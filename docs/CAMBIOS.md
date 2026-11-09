# Cambios

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
