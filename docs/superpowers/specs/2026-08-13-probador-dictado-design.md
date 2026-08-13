# Diseño: probador de dictado y flujo de configuración

## Objetivo

Hacer que Chamu muestre un probador de dictado en la pantalla principal. El usuario debe poder elegir el atajo y el modo, dictar y ver el texto dentro de un área de prueba.

## Alcance

### Onboarding

- Mantener dos pasos: modelo e idioma, y configuración de uso.
- Mantener el modelo local. No descargar ni borrar el modelo al reiniciar el onboarding.
- En el segundo paso, mostrar el área de texto de prueba, el campo de atajo y el selector de modo.
- Eliminar los botones separados para probar atajo, micrófono y pegado.
- Cuando termina un dictado, insertar el texto transcrito en el área de prueba si esa área tiene el foco. Copiar el texto al portapapeles como ahora.

### Pantalla principal

- Reemplazar la tarjeta de inicio e historial como superficie principal por el mismo probador.
- Mostrar el área de texto, el campo de atajo, el selector de modo, el estado y el control de dictado.
- Mantener el registro global del atajo durante esta pantalla.
- Al usar el atajo, aplicar el mismo ciclo que el botón: iniciar, detener, transcribir, copiar e insertar texto en el área de prueba.
- Si el área no tiene foco, conservar el resultado en el portapapeles y mostrar el estado de copia. No intentar simular un pegado dentro de otra aplicación.

### Configuración

- Mostrar sólo el idioma.
- Añadir la acción «Reiniciar onboarding».
- La acción elimina la clave local `chamu:onboarding-complete` y vuelve al onboarding.
- La acción no cambia `settings.json`, los modelos, el historial ni otro archivo nativo.

### Atajo global

- Mantener `CommandOrControl` como formato interno guardado.
- Antes de registrar o validar el atajo, convertirlo al modificador explícito de la plataforma. Usar `Ctrl` en Linux y Windows. Usar `Command` en macOS.
- Registrar el mismo valor normalizado para la validación y para el atajo activo.
- Mostrar el error del registro sólo si el registro normalizado falla.
- Al capturar un atajo, conservar la captura después de recibir sólo modificadores.
- Mostrar una vista previa de las teclas activas. Ejemplo: `Ctrl + Shift + …`.
- Aceptar el atajo sólo al recibir una tecla principal válida.
- Cancelar la captura con `Esc` sin cambiar el atajo guardado.
- Desregistrar temporalmente el atajo global durante la captura. Registrarlo otra vez al aceptar o cancelar.
- Mantener el mensaje de error sólo para una combinación completa no válida.

### Micrófono y comienzo del dictado

- Usar el dispositivo de entrada predeterminado del sistema, como ahora.
- Mostrar su nombre en el probador. Texto: `Micrófono activo: <nombre>`.
- Si no se puede leer el nombre, mostrar `Micrófono predeterminado del sistema`.
- No añadir selección ni persistencia de dispositivo en este cambio.
- Añadir el estado `Preparando micrófono…` desde el clic hasta que la captura nativa confirme el inicio.
- El estado de preparación no depende del modelo. La transcripción sigue después de detener el dictado.

### Ventana y diseño

- Usar una altura de ventana de escritorio que muestre la cabecera, el probador y el pie sin scroll vertical en una pantalla común.
- Dar al área de texto el espacio flexible restante.
- Conservar scroll interno sólo para texto extenso del área de prueba.
- Conservar una vista usable en ventanas pequeñas mediante una única columna y scroll de página cuando sea imprescindible.

### Prueba local

- Documentar los comandos de desarrollo para iniciar la aplicación Tauri.
- Documentar una prueba manual: hacer foco en el área, iniciar y detener con el botón y con el atajo, y comprobar el texto insertado y copiado.
- Documentar que el registro global depende de la sesión gráfica y de atajos ocupados por el sistema.

## Interfaces

- El puente nativo mantiene `startDictation(): Promise<DictationResult>` y `stopDictation(): Promise<DictationResult>`.
- `DictationResult` debe incluir el texto cuando el estado es `copied` para que la interfaz lo inserte.
- `App` recibe una devolución de reinicio desde `AppShell` y controla la clave de onboarding.
- Un único componente de probador recibe configuración, estado, acciones de dictado y una devolución para guardar configuración.

## Errores

- Si falla el registro global, mostrar el mensaje junto al campo de atajo. El botón de dictado sigue disponible.
- Si falla la captura, la transcripción o la copia, mostrar el estado de error. La aplicación no debe cerrarse.
- Si el dictado termina sin texto, no modificar el área de prueba.

## Pruebas

- Prueba de interfaz para insertar la transcripción en el área con foco.
- Prueba de interfaz para guardar atajo y modo desde el probador.
- Prueba de interfaz para reiniciar onboarding sin cambiar la configuración guardada.
- Prueba unitaria para normalizar `CommandOrControl` por plataforma.
- Prueba de interfaz para registrar el atajo normalizado.
- Prueba de interfaz para mantener la captura tras pulsar sólo modificadores y mostrar su vista previa.
- Prueba de interfaz para cancelar la captura con `Esc` sin cambiar el valor.
- Prueba de interfaz para pausar el atajo global durante la captura.
- Prueba Rust para devolver el nombre del micrófono predeterminado y el texto de reserva cuando no esté disponible.
- Prueba de interfaz para mostrar el nombre del micrófono y el estado de preparación.
- Pruebas de estilos para el diseño compacto de la ventana.
- Validación completa: `npm test`, `npm run typecheck`, `npm run build` y `cargo test -q` desde `src-tauri/`.

## Fuera de alcance

- No se guarda audio.
- No se pega texto de forma automática en otra aplicación.
- No se borra el historial al reiniciar onboarding.
- No se cambia la descarga ni la validación del modelo.
- No se añade selección de micrófono en esta iteración.
