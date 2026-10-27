// coding-v25-runtime-discovery-test.mjs
// Synthetic test for isolationRuntimeDiscovery module.
// Does not require real Docker or Windows Sandbox – it simply verifies the contract shape.

import { describe, it, expect } from 'node:test';
import { discoverIsolationRuntimes } from '../electron/coding-pipeline/isolationRuntimeDiscovery.cjs';
import path from 'path';

const projectRoot = path.resolve('C:/Users/Admin/Desktop/Ai_Help_Agent');

describe('isolationRuntimeDiscovery contract', () => {
  it('should return an array of candidate objects', () => {
    const candidates = discoverIsolationRuntimes(projectRoot);
    expect(Array.isArray(candidates)).toBe(true);
    // Verify required fields on each candidate.
    for (const c of candidates) {
      expect(typeof c.providerId).toBe('string');
      expect(typeof c.runtimeType).toBe('string');
      expect('available' in c).toBe(true);
      expect('healthCheck' in c).toBe(true);
      expect('isolationVerified' in c).toBe(true);
      expect(Array.isArray(c.supportedOps)).toBe(true);
      expect(typeof c.evidenceSource).toBe('string');
      expect(typeof c.timestamp).toBe('string');
    }
  });
});
