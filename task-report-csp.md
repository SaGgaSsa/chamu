# Informe de corrección CSP de fuentes locales

## Cambios

- Se añadió una aserción en `src/local-fonts.test.ts`.
- La prueba importa `src-tauri/tauri.conf.json` con `?raw`.
- La aserción exige `font-src 'self' data:`.
- Se añadió `font-src 'self' data:` al CSP existente.
- No se cambiaron otras directivas ni configuraciones.

## RED

Comando:

```text
npm test -- src/local-fonts.test.ts
```

Resultado antes del cambio:

```text
Test Files 1 failed (1)
Tests 1 failed | 1 passed (2)
```

El fallo indicó que el CSP no contenía `font-src 'self' data:`.

## Verification

- `npm test -- src/local-fonts.test.ts`: correcto, 2 pruebas.
- `npm test`: correcto, 9 archivos y 40 pruebas.
- `npm run typecheck`: correcto.
- `npm run build`: correcto.
- `git diff --check`: correcto antes del commit.

## Commit

Se crea un commit local en esta rama. El hash final se entrega en el handoff.

## Preocupaciones

Ninguna. El cambio queda limitado al CSP de fuentes y a su prueba.
