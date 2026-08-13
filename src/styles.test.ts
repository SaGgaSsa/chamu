/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import styles from './styles.css?raw';

describe('Chamu visual tokens', () => {
  it('declares the required dark surfaces, primary accents, and motion fallback', () => {
    expect(styles).toMatch(/--color-background\s*:\s*#131313\s*;/i);
    expect(styles).toMatch(/--color-surface\s*:\s*#131313\s*;/i);
    expect(styles).toMatch(/--color-on-surface\s*:\s*#e5e2e1\s*;/i);
    expect(styles).toMatch(/--color-primary-container\s*:\s*#00ff9c\s*;/i);
    expect(styles).toMatch(/--color-secondary-container\s*:\s*#3192fc\s*;/i);
    expect(styles).toMatch(/prefers-reduced-motion/i);
  });
});
