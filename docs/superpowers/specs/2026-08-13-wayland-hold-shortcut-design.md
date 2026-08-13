# Atajo mantener pulsado en Wayland

## Objetivo

Permitir que Chamu inicie el dictado al presionar un atajo global y lo detenga al soltarlo en sesiones Wayland compatibles.

## Decisión

Chamu usará el portal `org.freedesktop.portal.GlobalShortcuts` en Wayland. El portal emite `Activated` al presionar y `Deactivated` al soltar. El proceso Rust mantendrá la sesión del portal y emitirá cada cambio al frontend. El frontend usará esos eventos para iniciar y detener el dictado.

Chamu mantendrá `tauri-plugin-global-shortcut` en Windows, macOS y X11. No se leerá `/dev/input`. No se pedirán permisos de bajo nivel. No se usará `ydotool` para leer teclas.

## Flujo

1. El frontend consulta el diagnóstico de plataforma al cargar.
2. En Wayland y modo `hold`, solicita al backend una sesión de portal para el atajo configurado.
3. El portal puede mostrar su diálogo de permiso y asignación del atajo.
4. El backend emite `registered`, `pressed`, `released` o `error`.
5. El frontend inicia el dictado con `pressed` y lo detiene con `released`.
6. Al cambiar el atajo, el modo o desmontar la pantalla, el backend cierra la sesión anterior.

## Errores y compatibilidad

Si el portal no está disponible, el usuario cancela el diálogo o el portal no asigna el atajo, Chamu muestra el error. En ese caso, el usuario puede elegir el modo alternar. La aplicación no afirma que el atajo esté activo antes de recibir `registered`.

El estado visible indica el backend usado y la última transición. Esto permite probar localmente registro, presión y liberación.

## Pruebas

- Rust: conversión de formato de atajo a formato XDG y mapeo de eventos del portal.
- React: Wayland usa eventos del portal para iniciar y detener; otros entornos conservan el registro actual.
- Manual: en Wayland, aceptar el diálogo del portal, mantener el atajo, hablar y soltarlo; el texto debe llegar al campo de prueba.
