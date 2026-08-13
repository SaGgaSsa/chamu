# Registro host de Chamu para atajos Wayland

## Objetivo

Permitir que el portal XDG identifique a Chamu durante el desarrollo local y en paquetes Linux. Esto permite registrar atajos globales en modo mantener pulsado.

## Problema confirmado

El portal GlobalShortcuts está disponible en la sesión Wayland. Su respuesta falla antes de asignar el atajo. El portal no encuentra una aplicación con el identificador `com.chamu.desktop`.

Chamu no tiene un archivo `com.chamu.desktop.desktop`. Chamu tampoco registra su conexión D-Bus como aplicación host antes de usar el portal.

## Decisión

Chamu tendrá un archivo de escritorio con el nombre `com.chamu.desktop.desktop`. El identificador del archivo coincide con `identifier` en `src-tauri/tauri.conf.json`.

El backend Wayland registrará la conexión D-Bus actual en `org.freedesktop.host.portal.Registry` antes de crear una sesión GlobalShortcuts. Si el registro falla, Chamu mostrará el error específico y no solicitará el atajo.

El flujo de desarrollo instalará una copia del archivo de escritorio en el directorio local de aplicaciones XDG antes de iniciar Tauri. El flujo no sobrescribirá archivos fuera de la entrada de Chamu. Los paquetes Linux usarán el mismo archivo de escritorio.

## Flujo

1. `npm run tauri -- dev` prepara la entrada local `com.chamu.desktop.desktop`.
2. El proceso Tauri crea la conexión D-Bus del portal.
3. El proceso registra `com.chamu.desktop` en el host portal.
4. El backend crea la sesión GlobalShortcuts.
5. El backend solicita el atajo y emite `registered`, `pressed`, `released` o `error`.

## Errores

Si el archivo de escritorio no está disponible, el mensaje indicará la ruta y el comando local para prepararlo. Si el registro D-Bus falla, el mensaje incluirá la respuesta del portal y no se confundirá con un atajo no válido.

El registro host se intentará una sola vez por conexión del portal. El código aceptará que el portal no exponga Registry en escritorios que ya identifican la aplicación mediante su empaquetado.

## Pruebas

- Rust: el flujo de preparación registra la aplicación antes de `create_session`.
- Rust: el error de registro conserva el mensaje del portal.
- Node: el comando de desarrollo instala la entrada en el directorio XDG simulado y no toca otras rutas.
- Manual: ejecutar `npm run tauri -- dev`, seleccionar mantener pulsado y aceptar el diálogo del portal. El estado debe cambiar a registrado.
