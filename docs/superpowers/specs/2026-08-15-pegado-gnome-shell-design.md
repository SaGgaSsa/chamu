# Pegado automático con GNOME Shell

## Objetivo

Pegar el texto dictado en la ventana activa de máquinas Wayland que ejecutan
GNOME Shell 46 a 50, incluida la configuración que declara `Unity` pero usa
`gnome-shell` y Mutter. La solución no debe usar `sudo`, `ydotoold` ni el
portal de escritorio remoto.

## Arquitectura

Chamu incluirá una extensión de GNOME Shell con UUID `chamu@chamu.app`. La
extensión exportará un método D-Bus de sesión `Paste` y usará un teclado
virtual de Clutter/Mutter para enviar `Ctrl+V` al foco existente. La aplicación
Rust copiará el dictado al portapapeles y llamará ese método D-Bus.

Al iniciar, Chamu instalará o actualizará los archivos de la extensión en el
directorio de extensiones del usuario y solicitará su activación con
`gnome-extensions enable`. Esta acción no necesita privilegios de administrador.

## Flujo

1. Chamu instala la extensión si la sesión es Wayland GNOME o Unity sobre
   GNOME.
2. Chamu intenta activarla una vez por inicio.
3. El usuario suelta el atajo y Chamu transcribe el audio.
4. Chamu actualiza el portapapeles.
5. Chamu invoca `app.chamu.Input.Paste` por el bus de sesión.
6. La extensión crea un teclado virtual y emite `Ctrl+V`.
7. Si el método falla o la extensión no está activa, el texto permanece en el
   portapapeles y Chamu informa el pegado manual.

## Compatibilidad

- Soportar GNOME Shell 46, 47, 48, 49 y 50.
- Tratar `XDG_CURRENT_DESKTOP=Unity` como GNOME para estas máquinas.
- Fuera de GNOME Wayland, conservar el fallback de portapapeles sin inyección.

## Seguridad

La extensión se instala por usuario y no recibe permiso de capturar pantalla.
Su única interfaz D-Bus pública será `Paste`, que emite la secuencia
`Ctrl+V`. La extensión no lee texto, audio ni ventanas.

## Pruebas

- Probar los metadatos de la extensión y las versiones soportadas.
- Probar que Unity se diagnostica como GNOME.
- Probar el contrato Rust de llamada D-Bus y el fallback de portapapeles.
- Ejecutar las pruebas Rust, frontend, typecheck y build.
- Probar manualmente en GNOME Shell 46 con foco en otra aplicación.
