# Teclado virtual local para pegado Wayland

## Objetivo

Pegar el texto dictado en la ventana activa de Wayland sin solicitar el permiso
de escritorio remoto. Chamu debe usar un teclado virtual local administrado por
`ydotoold`.

## Alcance

- En Wayland, Chamu actualiza primero el portapapeles local.
- Chamu ejecuta `ydotool`, que usa el socket configurado para `ydotoold`.
- Si el daemon está disponible, el comando ejecuta la secuencia Linux `Ctrl+V`.
- Si el daemon no está disponible o el comando falla, Chamu conserva el texto
  en el portapapeles y devuelve una instrucción directa para activar el daemon.
- Chamu no usa `RemoteDesktop`, `ScreenCast` ni un portal para pegar.
- Chamu no usa `wtype` en Unity Wayland.

## Flujo

1. El usuario suelta el atajo.
2. Chamu transcribe el audio y actualiza el portapapeles.
3. En Wayland, Chamu ejecuta `ydotool key 29:1 47:1 47:0 29:0`.
4. Si el comando termina correctamente, Chamu informa que pegó el texto.
5. Si falla, Chamu informa que copió el texto y explica que debe iniciar
   `ydotoold` para habilitar el pegado automático.

## Seguridad

`ydotoold` crea un teclado virtual local mediante `/dev/uinput`. El daemon no
comparte la pantalla ni envía datos por red. El daemon puede generar teclas
locales. Chamu solo usa la secuencia `Ctrl+V` para pegar el texto que acaba de
copiar.

## Interfaz y errores

La interfaz no agrega una opción. El comportamiento es automático cuando el
daemon está activo. Si falta el daemon, el mensaje debe indicar que el texto
sigue en el portapapeles y que debe activar `ydotoold`.

## Pruebas

- Probar la detección del socket y la construcción de la secuencia `Ctrl+V`.
- Probar que una falla conserva el estado de texto copiado.
- Ejecutar pruebas Rust, pruebas frontend, typecheck y build.
- Probar manualmente en Unity Wayland con foco en otra aplicación.
