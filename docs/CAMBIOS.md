# Cambios

## 5.3.0

- Productos con costo de compra y precio de venta por unidad. El formulario muestra la ganancia bruta esperada y avisa cuando se vende por debajo del costo. El código/SKU deja de aparecer en formularios, búsquedas y listados.
- Cada venta conserva su costo unitario al cobrarla. Cambiar después el catálogo no altera los costos ni las ganancias históricas; las ventas anuladas se excluyen del reporte.
- Informes, CSV e impresión/PDF distinguen ingresos por productos, costo de productos vendidos y ganancia bruta. Los planes y otros gastos del gimnasio quedan fuera de esa ganancia.
- Los productos y ventas anteriores mantienen su costo sin registrar: no se les asigna cero ni el costo actual. Los reportes identifican las unidades pendientes y los importes parciales.
- Migración 025 sin pérdida de stock ni ventas. La gestión sin conexión conserva costos e históricos; el servidor mantiene un formato de sincronización compatible con las aplicaciones anteriores.
- Web, Windows y Android en 5.3.0; Android conserva paquete y firma y usa el código 5300. Se conserva la web 5.2.2 para sesiones abiertas.

## 5.2.2

- La cámara de recepción permanece habilitada al cambiar de pestaña del navegador, pantalla de gestión o método de registro. Se apaga con su botón o al terminar la sesión.
- El lector reanuda el vídeo al volver a la ventana y solicita otra captura si el sistema termina el flujo. El navegador o el sistema pueden suspender la captura en segundo plano.
- Windows abre los enlaces de WhatsApp en la aplicación instalada y recurre al navegador si no está disponible. El número del socio con código de país permite abrir el chat sin guardarlo en contactos; el envío se confirma en WhatsApp.
- Web, Windows y Android en 5.2.2; Android conserva paquete y firma y usa el código 5220. Se retiene la web 5.2.1 para sesiones abiertas.

## 5.2.1

- Respaldos exclusivos del superadministrador; los administradores de gimnasio no ven el apartado ni pueden usar sus API en la web, Android o Windows.
- Botón Respaldos por gimnasio en el panel del superadministrador, con creación, descarga, importación y restauración con contraseña, auditoría y verificación del gimnasio de origen.
- Se conservan las copias existentes y las protecciones automáticas antes de actualizar o recuperar datos.
- Página e instaladores actualizados a 5.2.1; Android conserva paquete y certificado y usa el código 5210.

## 5.2.0

- Android usa la gestión incluida como aplicación principal; se retiran la barra «Gestión / Lector sin conexión» y el selector de tema independiente.
- Windows usa la copia sincronizada del gimnasio, también al migrar una conexión remota anterior. Permite gestionar datos sin Internet y enviar los pendientes al reconectar.
- Tema, acento y densidad se guardan por gimnasio. Los administradores cambian la apariencia para los demás dispositivos, con aislamiento entre gimnasios y persistencia sin red.
- Reconexión y sincronización cada diez segundos durante la ejecución; intentos de conexión con límite de ocho segundos y transferencias con su propio plazo.
- Actualización de copias móviles 5.1.1 sin descargar de nuevo ni borrar sus pendientes. Se conservan el paquete, la firma Android y la autorización de siete días.
- APK Android con código 5200, instalador y portable Windows, página y código en 5.2.0.

## 5.1.1

- APK Android (código 5110), instalador y portable Windows recompilados con las fuentes actuales. Se mantienen el paquete y certificado Android.
- Color de acento por dispositivo y ajustes separados de Apariencia y Avisos y sonidos.
- Avisos del superadministrador a los gimnasios desde el panel, con importancia, vigencia y destinatarios. Llegan a la campana de alertas de cada gimnasio, se marcan como leídos por usuario y pueden retirarse antes de que venzan.
- El acceso deja de ofrecer la descarga de la versión portable de Windows; el instalador y el APK se mantienen.
- Las grabaciones de acceso pasan a ser «Acceso permitido» y «Acceso denegado»: la primera suena en cada escaneo válido, de entrada o de salida, y la segunda cuando el código no corresponde o está vencido. La sección Avisos y sonidos ofrece la opción «Audios de acceso permitido y denegado» y ofrece una prueba para cada caso.

## 5.1.0

- Gestión Android incluida en el APK y conectada a una copia SQLite del gimnasio para administradores: socios, planes, productos, cobros, credenciales, fotos, logotipo, configuración e informes sin Internet.
- Sincronización automática al recuperar conexión, volver a la aplicación y durante su uso. Los lotes persisten al reiniciar, los reintentos conservan sus identificadores y los conflictos no sobrescriben los cambios locales.
- Ampliación de una copia lectora anterior después de enviar sus accesos pendientes, sin borrar sus datos. Se conserva el paquete y la firma Android; código de compilación 5100.
- Las operaciones de cuenta central y los respaldos del servidor conservan su necesidad de Internet. La autorización local sigue siendo de siete días desde la última sincronización; las consultas y los pendientes se conservan al vencer.
- Web y Windows en 5.1.0 con el protocolo compatible; se conserva la interfaz web 5.0.0 para sesiones abiertas.

## 5.0.0

- Web, Android y Windows actualizados a 5.0.0; Android usa el código 5000 y conserva el paquete y su firma.
- Windows incorpora las mejoras web recientes: logotipo del gimnasio, marca de agua y estilo de credenciales, vista previa de tarjeta, ajustes del tema oscuro y consultas de movimientos y horas por socio.
- Descargas directas del APK, instalador Windows y portable desde el acceso y Configuración.
- Se conserva la interfaz publicada 4.8.2 para las sesiones abiertas.

## 4.8.2

- Añadidas las dos grabaciones proporcionadas: el primer audio para la entrada y el segundo para la salida, con volumen ajustado sin saturación.
- Nueva opción «Audios de entrada y salida» en Apariencia, seleccionada por defecto para las preferencias automáticas anteriores. Se mantienen las voces elegidas y la opción de silenciar los avisos.
- Las pruebas de entrada y salida reproducen las grabaciones sin añadir nombres ni voces sintetizadas.
- El lector Android incluye los audios para usarlos sin conexión y descarta avisos pendientes cuando llega un movimiento nuevo.
- Web, Windows y Android actualizados a 4.8.2; Android usa el código 4802. Se conserva la interfaz publicada 4.8.1 para las sesiones abiertas.

## 4.8.1

- Verde oliva `#636B2F` en los botones principales de web, Windows y Android, con texto blanco legible.
- Restauradas las superficies anteriores de los temas claro y oscuro, sin invertir los colores de las barras de navegación.
- Apariencia muestra vistas previas de ambos temas y agrupa los avisos y sus controles de voz.
- La barra lateral contraída deja de mostrar el QR sobre los iconos; el menú móvil conserva el nombre del gimnasio.
- Web, Windows y Android actualizados a 4.8.1; Android usa el código 4801. Se conserva la interfaz publicada 4.8.0 para las sesiones abiertas.

## 4.8.0

- Paleta común con blanco como base del tema claro, negro como base del oscuro y verde fosforescente `#B6FF00` como acento. La composición sigue la proporción visual 60/30/10 en superficies, navegación y acciones.
- Menús, cabeceras, tablas, formularios, caja, socios, recepción, informes y configuración comparten los colores. Los botones verdes usan texto negro; los controles y avisos mantienen contraste legible.
- Cambio rápido de tema desde la barra y desde el acceso. Android incluye el cambio de tema en su navegación nativa y conserva la elección al volver a abrir el lector sin conexión.
- Web, Windows y Android actualizados a 4.8.0; Android usa el código 4800. Se conserva la interfaz 4.7.1 para las sesiones abiertas.

## 4.7.1

- El inicio local permite abrir la cuenta del servidor central sin sustituir la base de la computadora. Windows conserva la conexión directa al reiniciar, evitando volver a una copia vinculada a otra cuenta.
- La cabecera identifica servidor central, servidor local, copia sincronizada, desconexión y cambios pendientes. La comprobación de salud conserva su ruta central al entrar en un gimnasio.
- Botón para mostrar y ocultar las contraseñas de acceso, alta, recuperación y configuración en web y Windows; también en el lector nativo Android.
- Android actualizado al código 4701. Se conservan los recursos web 4.7.0 para las sesiones abiertas.

## 4.7.0

- Diez voces en español, selección por nombre y pruebas de entrada y salida.
- Voces optimizadas con descarga paralela, motor comprimido y reutilización de avisos; velocidad entre 50 % y 300 %.
- Botón Guardar cambios en Apariencia.
- Importación de archivos .gympassbackup con comprobación de integridad e identidad del gimnasio; restauración confirmada con copia previa.
- Android (código 4700) y Windows actualizados, conservando la identidad y los datos de las aplicaciones.
- Se conserva la web 4.6.0 para las sesiones abiertas.

## 4.6.0

- Consulta de presencia optimizada para reducir el coste del historial en recepción, informes y mantenimiento, conservando el resultado anterior.
- Respuestas JSON grandes comprimidas con Brotli o gzip según el cliente; las respuestas pequeñas se envían directamente.
- Colores de temas compatibles con Chrome y Edge 109; objetivos de compilación fijados y nuevas comprobaciones de compatibilidad y compresión en la verificación.
- Android (código 4600) y Windows actualizados a 4.6.0 con el código compartido y la interfaz actuales, conservando identidad y datos.
- Se conservan los recursos web publicados de 4.5.7 para las sesiones abiertas. Windows mantiene Electron 45 y la política existente de distribución sin firma de código.

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
