# Diseño: dictado rápido y pegado en Wayland

## Objetivo

Eliminar la espera previa a la transcripción y pegar el texto en el campo activo de otra aplicación. Chamu debe conservar el modelo Whisper base cargado mientras el proceso esté abierto.

## Problema confirmado

Al soltar el atajo, Chamu calcula el SHA-256 completo del modelo y construye un `WhisperContext` nuevo. El modelo base local mide 147 951 465 bytes. El cálculo del SHA-256 tomó aproximadamente un segundo en el equipo de prueba. El resto de la espera ocurre al iniciar Whisper antes de la inferencia.

El comando nativo actual actualiza el portapapeles. No inyecta el pegado. El `DictationTester` recibe el resultado, inserta el texto en su propio `textarea` y le da foco. Por esa razón, el resultado siempre aparece en el probador.

La sesión de prueba usa Wayland y Unity. `wtype` está disponible, pero no es un método confiable para Unity. `ydotool` está instalado, pero `ydotoold` no está activo. El portal `org.freedesktop.portal.RemoteDesktop` está disponible.

## Decisión

Chamu mantendrá un contexto Whisper validado y compartido en `RuntimeState`.

- La aplicación validará el archivo con SHA-256 una vez antes de cargar el contexto.
- La aplicación cargará el modelo en una tarea bloqueante fuera del hilo principal.
- La aplicación creará un `WhisperState` nuevo por dictado. El estado y el audio no se reutilizan.
- Si el modelo no está listo al soltar el atajo, esa primera transcripción esperará la carga. Las posteriores reutilizarán el contexto.
- La aplicación no guardará audio ni transcripciones adicionales.
- Si la validación o carga falla, Chamu no conservará el contexto y mostrará el error existente.

Para Wayland, Chamu abrirá una sesión de `RemoteDesktop` con permiso de teclado y enviará `Ctrl+V` por el portal después de actualizar `wl-copy`. La sesión permanece válida durante la ejecución de la aplicación. El portal pide consentimiento cuando sea necesario.

El `DictationTester` seguirá siendo un probador local. Solo insertará el resultado en su `textarea` cuando el usuario haya dejado foco allí antes de iniciar el dictado. No recuperará foco cuando el resultado llegue. Si el foco estaba en otra aplicación, el texto se pegará en esa aplicación y el probador mostrará el resultado sin modificar su campo.

## Flujo

1. El usuario deja foco en un campo de otra aplicación y mantiene el atajo.
2. Chamu captura audio solo en memoria.
3. El usuario suelta el atajo.
4. Chamu detiene la captura en un worker.
5. Chamu reutiliza el contexto Whisper cargado y crea un estado nuevo para inferir.
6. Chamu escribe el texto en el portapapeles Wayland con `wl-copy`.
7. Chamu envía `Ctrl+V` al campo activo mediante `RemoteDesktop`.
8. Chamu guarda solo el texto en el historial y actualiza el estado de la interfaz.

## Diagnóstico

El backend medirá y registrará, sin contenido de audio ni texto:

- tiempo de detener la captura;
- tiempo de esperar o cargar el modelo;
- tiempo de inferencia;
- tiempo de actualizar el portapapeles e inyectar el pegado.

Los mensajes deben permitir distinguir un modelo en carga de una inferencia lenta.

## Límites y errores

- El pegado automático requiere el permiso del portal de escritorio. Si el usuario lo rechaza o el portal falla, Chamu conservará el texto en el portapapeles y mostrará un error claro.
- El portal es el método principal en Wayland. No se debe depender de `wtype` en Unity.
- La implementación no debe bloquear el hilo principal de Tauri.
- La implementación no debe retener `MutexGuard` a través de un `await`.
- El contexto compartido debe impedir dos inferencias simultáneas.

## Pruebas

- Probar que una caché de modelo reutiliza el contexto validado para más de un dictado.
- Probar que una carga fallida no queda almacenada.
- Probar que el probador no fuerza foco ni modifica el texto cuando no tenía foco al iniciar.
- Probar que el flujo de pegado intenta el portal después de actualizar el portapapeles.
- Ejecutar `cargo test -q` en `src-tauri/`.
- Ejecutar `npm test`, `npm run typecheck` y `npm run build`.
- Probar manualmente en Wayland/Unity: foco externo, atajo, dictado y pegado.
