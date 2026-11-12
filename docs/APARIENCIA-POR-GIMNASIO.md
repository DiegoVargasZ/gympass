# Apariencia del gimnasio

Desde 5.2.0, tema claro u oscuro, color de acento y densidad de tablas se guardan en la base de cada gimnasio. El logotipo, su marca de agua y el estilo de credenciales también pertenecen al gimnasio. Una cuenta administradora cambia estos ajustes desde Configuración → Apariencia; las demás cuentas los reciben al actualizar los datos.

La web recibe los cambios por el canal del gimnasio y usa consultas cada diez segundos cuando ese canal no está disponible. Android y Windows guardan los cambios en su copia local y sincronizan automáticamente cada diez segundos durante su ejecución, además de los avisos de conectividad y las actualizaciones tras una operación. Ningún cambio modifica la apariencia de otro gimnasio.

Sin Internet se muestra la última apariencia guardada en la copia. Un cambio hecho sin red se envía al reconectar; los dispositivos desconectados lo reciben cuando también se reconectan. Si dos dispositivos cambian el mismo ajuste de forma incompatible, se conserva el pendiente y se solicita revisión en Conexión.

Los ajustes visuales antiguos del navegador o de la aplicación no se importan como configuración del gimnasio. Los valores iniciales son tema claro, verde oliva y densidad cómoda. Antes de iniciar sesión, el tema de la pantalla de acceso puede seguir siendo local. Avisos y sonidos conserva su configuración de reproducción por dispositivo.

El intervalo de diez segundos funciona mientras la aplicación está ejecutándose. Si el sistema la cierra, la sincronización se retoma al abrirla. Las operaciones de cuenta central y la primera vinculación necesitan conexión; se conserva la autorización local de siete días.
