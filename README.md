# Chamu

Chamu es una aplicación de escritorio para dictado local en Linux y Windows. La interfaz inicial está en español y el alcance del MVP es **Windows x64** y **Linux x86_64**.

El flujo está pensado para ser breve: un atajo inicia o detiene el dictado, Chamu transcribe con whisper.cpp integrado en el equipo, copia el resultado al portapapeles, intenta pegarlo en la aplicación activa y conserva únicamente el texto y su fecha en el historial.

## Privacidad por diseño

- No hay cuentas, inicio de sesión, telemetría ni API de transcripción.
- El audio es temporal y se descarta siempre al finalizar o cancelar el dictado; no se guarda en disco.
- El historial local contiene sólo texto y fecha/hora, en la base SQLite de la aplicación.
- La red se usa únicamente cuando la persona confirma la descarga de un modelo o la búsqueda/instalación de una actualización.
- Los diagnósticos locales sólo registran sesión, compositor, atajo, método de captura/pegado y dependencias; no incluyen audio ni texto dictado.

## Modelo local

El modelo multilingüe inicial es `ggml-base.bin` de whisper.cpp (aproximadamente 142 MiB). Se puede detectar un archivo existente o descargarlo durante el onboarding. whisper.cpp viaja dentro de la aplicación, por lo que no hace falta instalar ni configurar otro ejecutable. La aplicación valida el SHA-256 antes de usarlo y rechaza archivos modificados:

```text
60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
```

La descarga sólo comienza después de una confirmación explícita y usa la fuente oficial de whisper.cpp: <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin>.

## Wayland y dependencias

En X11 y Windows Chamu gestiona el atajo y el pegado. En Wayland se detecta GNOME, KDE, Hyprland u otro compositor y se utiliza su mecanismo cuando está disponible. Si el compositor no permite detectar presionar y soltar, el onboarding limita el modo a **pulsar para alternar**; no se promete un atajo universal.

Para clipboard y pegado en Wayland se necesita:

- `wl-clipboard` (`wl-copy` y `wl-paste`), y
- `wtype` (preferido) o `ydotool` para inyectar el pegado.

El diagnóstico de Chamu muestra cuál falta y propone un comando según la distribución. Como referencia:

```bash
# Debian/Ubuntu
sudo apt install wl-clipboard wtype

# Fedora
sudo dnf install wl-clipboard wtype

# Arch Linux
sudo pacman -S wl-clipboard wtype
```

`ydotool` puede usarse como alternativa a `wtype`, pero puede requerir configurar su servicio y permisos según la distribución. Después de instalar una dependencia, vuelve a ejecutar la prueba desde el onboarding.

## Desarrollo local

Requisitos: Node.js 22 o posterior, Rust estable y las dependencias de Tauri 2 para tu plataforma.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run tauri dev
```

El servidor Vite usa `127.0.0.1:1420`, el mismo puerto que `build.devUrl` de Tauri. El puerto es estricto para evitar que Vite elija otro silenciosamente.

## Releases y actualizaciones

Los tags `vX.Y.Z` disparan [`.github/workflows/release.yml`](.github/workflows/release.yml), que construye:

- Windows x64: instalador NSIS (`.exe`).
- Linux x86_64: AppImage y paquete `.deb`.

Las releases se publican en GitHub con [`.github/RELEASE_MATRIX.md`](.github/RELEASE_MATRIX.md) como lista de prueba manual. El workflow exige las credenciales de firma antes de publicar: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` y `TAURI_UPDATER_PUBLIC_KEY`. Si faltan, la ejecución termina sin publicar artefactos potencialmente inseguros.

La configuración versionada contiene el endpoint de actualizaciones y el marcador `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`. El workflow crea una configuración temporal con la clave pública del secreto y habilita los artefactos firmados sólo durante una release autorizada. Nunca se permite transporte HTTP inseguro. En el binario de desarrollo el marcador hace que el actualizador no sea utilizable hasta configurar una clave real: falla de forma segura.

Chamu sólo descarga una actualización después de que la persona la confirma y la aplica al reiniciar. No se descarga código ni modelo en segundo plano.

## Licencia

Chamu se distribuye bajo la [licencia MIT](LICENSE).
