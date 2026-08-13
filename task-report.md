# Informe: fuentes locales del renderer

## Cambios

- Se añadieron `@fontsource/geist@5.3.0` y `@fontsource/jetbrains-mono@5.3.0` como dependencias de runtime.
- Se creó `src/fonts.css`.
- `src/fonts.css` importa solo CSS local de Fontsource para Geist 400/600 y JetBrains Mono 400/600/700.
- `src/fonts.css` expone `--font-body`, `--font-display` y `--font-mono`.
- `src/main.tsx` importa `src/fonts.css` antes de `src/styles.css`.
- Se añadió `src/local-fonts.test.ts` para verificar el enlace del entrypoint y los imports locales.
- Se añadió `src/vite-env.d.ts` para tipar los imports `?raw` usados por la prueba.
- No se modificó `src/styles.css`, componentes, contratos nativos ni conducta de la aplicación.

## TDD

RED funcional ejecutado antes del cambio de producción:

```text
Error: Failed to resolve import "./fonts.css?raw" from "src/local-fonts.test.ts".
```

El fallo se produjo porque `src/fonts.css` todavía no existía.

## Verificación

- `npm test`: pasa. 8 archivos, 30 pruebas.
- `npm test -- src/local-fonts.test.ts`: pasa. 1 prueba.
- `npm run typecheck`: pasa.
- `npm run build`: pasa.
- `git diff --check`: pasa.
- La inspección de `dist` no encontró URLs HTTP/HTTPS ni imports de CDN en los CSS generados.

## Activos de `dist`

Vite generó 19 archivos WOFF2 locales en `dist/assets`, con familias y pesos seleccionados:

- Geist: latin, latin-ext, cyrillic, vietnamese; pesos 400 y 600.
- JetBrains Mono: latin, latin-ext, cyrillic, greek, vietnamese; pesos 400, 600 y 700.

Algunos WOFF2 pequeños se incorporaron como `data:` URLs por el umbral de inline de Vite. Los restantes se emitieron como archivos locales. Ninguno requiere una solicitud de red externa.

## Commit

`feat: bundle local renderer fonts`

## Preocupaciones

- `src/styles.css` debe consumir `--font-body` para texto y `--font-display` o `--font-mono` para titulares, etiquetas y estados cuando el agente raíz reemplace sus estilos.
- Fontsource incluye también formatos WOFF de fallback. Estos archivos son locales y no añaden una dependencia de red.
