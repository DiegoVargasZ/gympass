# Gestión móvil sin conexión

Android 5.3.0 incluye la interfaz de gestión y una base SQLite privada del gimnasio. Una cuenta administradora puede registrar socios, gestionar productos, existencias y planes, cobrar, consultar o compartir credenciales, registrar accesos, guardar fotos y logotipos, cambiar la configuración del gimnasio y consultar o exportar informes sin Internet. Las correcciones de horas también quedan guardadas localmente.

## Preparación

1. Instala el APK sobre la versión anterior, sin desinstalar ni borrar sus datos.
2. Entra una vez con Internet y una cuenta administradora del gimnasio.
3. Espera a que termine la preparación de la copia local. Si había lecturas pendientes del lector anterior, se envían antes de ampliar su copia.
4. Después, abre la aplicación incluso sin conexión. El estado indica los cambios guardados en el teléfono y su sincronización. No hay una pestaña adicional «Lector sin conexión»: la recepción forma parte de la aplicación.

El lector y sus consultas siguen disponibles para las cuentas de recepción. Estas cuentas conservan su alcance anterior; no reciben una copia administrativa ni las claves de las credenciales.

## Sincronización automática

Los cambios se escriben primero en SQLite. La aplicación intenta enviarlos al guardarlos, al recibir un aviso de conectividad, al volver a primer plano y cada diez segundos durante su ejecución. También descarga los cambios confirmados de otros equipos, incluida la apariencia del gimnasio. Si Android cierra la aplicación, la sincronización se reanuda al abrirla; no se promete ejecución inmediata mientras el sistema la mantiene cerrada.

Una respuesta perdida conserva el identificador del lote para reintentarlo sin duplicar ventas ni accesos. Los cambios hechos durante una transferencia se conservan para el siguiente lote. Reiniciar el teléfono o la aplicación no elimina los pendientes.

Si dos equipos modifican el mismo dato o consumen existencias o sesiones incompatibles, se conserva la copia local y el lote queda para revisión en Equipos vinculados. No se resuelve sobrescribiendo silenciosamente una de las copias.

## Operaciones que requieren conexión

La primera vinculación, la autenticación de una cuenta nueva, la recuperación o modificación de contraseñas, las cuentas del personal y las copias de seguridad del servidor son operaciones de la cuenta central. Se realizan con Internet desde el servidor. Los envíos por WhatsApp también requieren la conexión de ese servicio; generar, copiar o guardar la imagen de la credencial puede hacerse sin red.

Se conserva la autorización local de siete días desde la última sincronización correcta. Al vencer, las consultas y los pendientes permanecen guardados, pero es necesario reconectar para autorizar nuevas escrituras. Revocar la cuenta, cambiar su contraseña o revocar el dispositivo invalida su autorización cuando el servidor vuelve a ser accesible.

La clave de las credenciales se guarda en SecureStore. No se copia a la interfaz web ni se incorpora al APK. La interfaz local solo entrega archivos del programa; los datos y las operaciones del gimnasio pasan por el puente de la sesión vinculada.

Los respaldos se administran exclusivamente con una cuenta de superadministrador, desde el panel central y el botón Respaldos de cada gimnasio. No se ofrecen a las cuentas administradoras del gimnasio.
