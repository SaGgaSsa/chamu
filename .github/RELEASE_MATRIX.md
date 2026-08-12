# Matriz manual de release

Esta lista se ejecuta para cada tag `vX.Y.Z` además de las comprobaciones automáticas del workflow. Una release no se considera lista hasta que todas las plataformas previstas pasen la prueba con una instalación limpia.

## Preflight común

- [ ] Confirmar que el tag sigue `vX.Y.Z` y que la versión de `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json` coincide.
- [ ] Confirmar que la release contiene NSIS, AppImage y `.deb` para x64, junto con las firmas generadas.
- [ ] Verificar SHA-256 de los artefactos descargados y que el instalador no incluye grabaciones de audio ni credenciales.
- [ ] Confirmar que `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` y `TAURI_UPDATER_PUBLIC_KEY` no aparecen en logs ni artefactos.
- [ ] Confirmar que la app no hace solicitudes de red al arrancar y que sólo solicita red después de aceptar una descarga de modelo o actualización.

## Windows x64

- [ ] Instalar el NSIS `.exe` en un perfil nuevo y abrir Chamu desde el menú Inicio y el tray.
- [ ] Completar onboarding con modelo ausente: cancelar, reintentar, validar checksum y comprobar que el archivo no se usa si está alterado.
- [ ] Probar micrófono, clipboard y pegado en un editor; comprobar modos mantener pulsado y alternar.
- [ ] Capturar `Ctrl + Super`, verificar el atajo alternativo y comprobar la tecla `Ctrl` sólo en una versión de Windows donde la captura global funcione.
- [ ] Dictar español e inglés, confirmar el flujo transcribir → copiar → pegar y que el historial sólo conserva texto y fecha.
- [ ] Reiniciar la app y comprobar que configuración e historial persisten.
- [ ] Desde una release anterior, buscar la nueva versión, confirmar manualmente, reiniciar y verificar la firma antes de actualizar.

## Linux x86_64 / X11

- [ ] Instalar el `.deb` y abrir la app; instalar el AppImage en un directorio sin privilegios y ejecutar desde allí.
- [ ] Probar atajo global, modos mantener/alternar, micrófono, clipboard, pegado e historial en X11.
- [ ] Repetir el onboarding de modelo ausente/existente y la validación de checksum.
- [ ] Confirmar que el diagnóstico identifica `x11-global-hook` y no registra audio ni texto.
- [ ] Verificar actualización firmada desde una versión anterior y el reinicio para aplicar.

## Linux x86_64 / Wayland

Ejecutar la matriz al menos en GNOME, KDE Plasma y Hyprland. Si una sesión no permite distinguir presionar/soltar, el resultado esperado es modo alternar asistido.

- [ ] Comprobar que el diagnóstico identifica el compositor y la sesión Wayland.
- [ ] Con `wl-clipboard` y `wtype`, probar copiar y pegar en una aplicación nativa y en una aplicación XWayland.
- [ ] Repetir con `ydotool` como alternativa y registrar cualquier requisito de servicio/permisos.
- [ ] Quitar temporalmente cada dependencia (`wl-clipboard`, `wtype`/`ydotool`), confirmar que el onboarding muestra el comando específico de la distribución y volver a probar después de instalarla.
- [ ] Confirmar que GNOME/KDE/Hyprland usan el mecanismo de atajo disponible y que el modo mantener pulsado se deshabilita cuando no hay eventos de soltar.
- [ ] Verificar clipboard, pegado, historial, descarte de audio y actualización firmada.

## Evidencia

Guardar en la incidencia de release el sistema, compositor, versión de Chamu, método de captura, método de pegado y resultado de cada casilla. No adjuntar audio, texto dictado, tokens ni claves privadas.
