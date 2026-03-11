import { describe, it, expect } from 'vitest';
import { version } from './index.js';

describe('M0 Smoke Test', () => {
  it('exports version', () => {
    expect(version).toBe('0.1.0');
  });
});
