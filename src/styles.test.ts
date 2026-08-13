/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import styles from './styles.css?raw';

function cssBlock(selector: string): string {
  const match = styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('Chamu visual tokens', () => {
  it('declares the required dark surfaces, primary accents, and motion fallback', () => {
    expect(styles).toMatch(/--color-background\s*:\s*#131313\s*;/i);
    expect(styles).toMatch(/--color-surface\s*:\s*#131313\s*;/i);
    expect(styles).toMatch(/--color-on-surface\s*:\s*#e5e2e1\s*;/i);
    expect(styles).toMatch(/--color-primary-container\s*:\s*#00ff9c\s*;/i);
    expect(styles).toMatch(/--color-secondary-container\s*:\s*#3192fc\s*;/i);
    expect(styles).toMatch(/prefers-reduced-motion/i);
  });

  it('uses the dark theme color in the document shell', () => {
    expect(indexHtml).toMatch(/<meta\s+name="theme-color"\s+content="#131313"\s*\/>/i);
  });

  it('uses the dark text token on the blue primary button', () => {
    expect(cssBlock('\\.primary-button')).toMatch(/color:\s*var\(--color-on-secondary-container\)\s*;/i);
    expect(styles).toMatch(/\.primary-button:hover:not\(:disabled\)[^{]*\{[^}]*color:\s*var\(--color-on-secondary-fixed\)\s*;/i);
  });

  it('keeps the recording pulse visible when its animation is disabled', () => {
    expect(cssBlock('\\.dictation-control__pulse')).toMatch(/opacity:\s*1\s*;/i);
    expect(cssBlock('\\.dictation-control__pulse')).toMatch(/animation:\s*dictation-pulse\s+1\.4s/i);
  });

  it('keeps the glass surface at the documented 40 percent opacity', () => {
    expect(styles).toMatch(/--surface-glass\s*:\s*color-mix\(in srgb, var\(--color-surface-container\)\s+40%,\s*transparent\)\s*;/i);
  });

  it('uses the documented 1200 pixel page container maximum', () => {
    expect(styles).toMatch(/width:\s*min\(100%,\s*1200px\)\s*;/i);
    expect(styles).not.toMatch(/1232px/i);
  });

  it('keeps generic header and card accents out of the green recording token', () => {
    for (const selector of ['\\.eyebrow', '\\.brand-mark', '\\.settings-button svg', '\\.welcome-card::before']) {
      expect(cssBlock(selector)).not.toMatch(/--color-(?:success|recording)|--border-active/i);
    }
  });

  it('stops the recording pulse animation when reduced motion is requested', () => {
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.dictation-control__pulse[\s\S]*?animation:\s*none(?:\s*!important)?\s*;/i);
  });
});
