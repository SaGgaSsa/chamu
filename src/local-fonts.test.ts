import entrySource from './main.tsx?raw';
import fontsSource from './fonts.css?raw';

describe('local renderer fonts', () => {
  it('imports the local font stylesheet from the renderer entrypoint', () => {
    expect(entrySource).toContain("import './fonts.css';");
    expect(fontsSource).toContain("@import '@fontsource/geist/400.css';");
    expect(fontsSource).toContain("@import '@fontsource/geist/600.css';");
    expect(fontsSource).toContain("@import '@fontsource/jetbrains-mono/400.css';");
    expect(fontsSource).toContain("@import '@fontsource/jetbrains-mono/600.css';");
    expect(fontsSource).toContain("@import '@fontsource/jetbrains-mono/700.css';");
    expect(fontsSource).toContain('--font-body');
    expect(fontsSource).toContain('--font-mono');
  });
});
