import { describe, it, expect } from 'vitest';
import { version, getVersion } from './index';

describe('M0 Smoke Test', () => {
  it('should export version constant', () => {
    expect(version).toBe('0.0.0');
  });

  it('should return version from getVersion()', () => {
    expect(getVersion()).toBe('0.0.0');
  });
});
