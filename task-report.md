# Informe de revisión visual

## Cambios

- Se hizo visible el círculo del pulso durante la grabación.
- Se eliminó `opacity="0"` del círculo SVG.
- Se mantuvo el pulso en CSS.
- Se desactivó la animación del pulso con `prefers-reduced-motion`.
- Se usó `--color-on-secondary-container` en el botón primario normal.
- Se mantuvo el azul `#3192fc` en el fondo primario.
- Se cambiaron a azul o neutro los acentos genéricos de eyebrow, marca, icono de cabecera y línea de tarjeta.
- Se conservó verde para privacidad, grabación, copiado/éxito y foco de grabación.
- Se cambió `theme-color` a `#131313`.
- Se cambió `--surface-glass` a 40%.
- Se cambiaron los contenedores de página a máximo 1200px.
- No se cambiaron contratos nativos, textos funcionales, fuentes, package json, comandos ni DESIGN.md.

## RED

Prueba inicial después de añadir las pruebas:

```text
npm test -- --run src/components/AppShell.test.tsx src/styles.test.ts
Test Files 2 failed (2)
Tests 6 failed | 13 passed (19)
```

Fallos observados:

- El círculo del pulso tenía `opacity="0"`.
- El botón primario usaba `--color-on-surface`.
- `--surface-glass` usaba 78%.
- Los contenedores usaban 1232px.
- Los cuatro selectores genéricos usaban tokens verdes.

La primera ejecución no encontró Vitest porque el worktree no tenía dependencias. Se ejecutó `npm ci` y se repitió la prueba para obtener el fallo funcional.

## Verification

- `npm test`: 9 archivos y 39 pruebas correctas.
- `npm run typecheck`: correcto.
- `npm run build`: correcto.
- `git diff --check`: correcto.
- Inspección final: no queda `opacity="0"` en el pulso.
- Inspección final: el botón primario normal usa `--color-on-secondary-container`.
- Inspección final: no queda verde en `.eyebrow`, `.brand-mark`, `.settings-button svg` ni `.welcome-card::before`.

## Commit

Se crea un commit local en esta rama. El hash final se entrega en el handoff.

## Preocupaciones

- La prueba de CSS usa aserciones estables sobre el texto fuente porque Vitest no calcula estilos CSS.
- No se ejecutó una prueba manual de Tauri; este fix no cambia comportamiento nativo.
