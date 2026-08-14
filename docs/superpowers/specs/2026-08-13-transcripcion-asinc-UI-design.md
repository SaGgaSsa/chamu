# Diseño: transcripción sin bloquear la interfaz

## Objetivo

Evitar el aviso del sistema "Chamu no responde" al soltar el atajo de dictado.

## Causa confirmada

`stop_dictation` es un comando síncrono de Tauri. Detiene el micrófono y llama a
Whisper en el hilo principal. Whisper usa CPU durante la transcripción. La
ventana no procesa eventos del sistema durante ese intervalo.

## Diseño

El comando de detención será asíncrono. Mantendrá la captura, la verificación
del modelo y la transcripción fuera del hilo principal.

1. El comando toma y detiene la captura de audio.
2. El comando cambia el ciclo interno a `Transcribing`.
3. Una tarea bloqueante ejecuta la verificación del modelo y Whisper.
4. Al terminar, el comando guarda el texto en el historial y lo copia al
   portapapeles.
5. El resultado existente `copied` o `error` vuelve al probador.

La interfaz ya cambia a `Transcribiendo…` antes de invocar el comando. No se
cambia el contrato TypeScript ni el comportamiento del atajo.

## Límites

- El audio sigue solo en memoria.
- No se crean procesos externos.
- No se cambia el modelo ni la selección de micrófono.
- No se cambia el protocolo del portal Wayland.

## Errores

Si falla la captura, el modelo, Whisper, el historial o el portapapeles, el
ciclo pasa a `Error`. El error existente se devuelve al probador.

## Pruebas

- Una prueba Rust verifica que la preparación de la tarea conserva el idioma y
  la ruta de modelo sin audio persistente.
- Las pruebas de interfaz conservan el estado `Transcribiendo…` mientras la
  promesa de detención sigue pendiente.
- Se ejecutan `npm test`, `npm run typecheck`, `npm run build` y `cargo test -q`.
- Se prueba manualmente: mantener el atajo, soltarlo, mover la ventana durante
  `Transcribiendo…`, y confirmar que no aparece el aviso de bloqueo.
