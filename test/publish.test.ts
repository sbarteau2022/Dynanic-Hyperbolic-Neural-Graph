import { describe, it, expect } from 'vitest';
import { buildAtlas } from '../src/cartographer';
import { serializeAtlas, canonicalJSON } from '../src/publish';
import type { MemEvent } from '../src/core/events';

const EVENTS: MemEvent[] = [
  { kind: 'assoc', src: 'a', dst: 'b', weight: 1, ts: 1 },
  { kind: 'derived', src: 'a', dst: 'c', weight: 1, ts: 2 },
];

describe('canonicalJSON', () => {
  it('is stable under key-insertion-order (recursively sorted keys)', () => {
    const a = { z: 1, a: { y: 2, x: 3 } };
    const b = { a: { x: 3, y: 2 }, z: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe('serializeAtlas', () => {
  it('is deterministic: identical core + meta ⇒ identical hash', () => {
    const core = buildAtlas(EVENTS, { epochs: 60, seed: 5 });
    const s1 = serializeAtlas(core, { version: '1', created_at: 1000 });
    const s2 = serializeAtlas(core, { version: '1', created_at: 1000 });
    expect(s1.hash).toBe(s2.hash);
  });

  it('changes hash when the atlas content changes', () => {
    const core1 = buildAtlas(EVENTS, { epochs: 60, seed: 5 });
    const core2 = buildAtlas([...EVENTS, { kind: 'assoc', src: 'c', dst: 'd', weight: 1, ts: 3 }], { epochs: 60, seed: 5 });
    const s1 = serializeAtlas(core1, { version: '1', created_at: 1000 });
    const s2 = serializeAtlas(core2, { version: '1', created_at: 1000 });
    expect(s1.hash).not.toBe(s2.hash);
  });

  it('does NOT change hash when only created_at/version differ but content is identical — wait, it should', () => {
    // created_at and version ARE part of the hashed payload (they're in the
    // published snapshot), so a re-publish of unchanged content at a new
    // timestamp still gets a fresh hash — that's correct: the hash addresses
    // the whole published artifact, not just the geometry.
    const core = buildAtlas(EVENTS, { epochs: 60, seed: 5 });
    const s1 = serializeAtlas(core, { version: '1', created_at: 1000 });
    const s2 = serializeAtlas(core, { version: '2', created_at: 2000 });
    expect(s1.hash).not.toBe(s2.hash);
  });

  it('carries the full atlas core plus version/created_at/hash', () => {
    const core = buildAtlas(EVENTS, { epochs: 40 });
    const snap = serializeAtlas(core, { version: '3', created_at: 5000 });
    expect(snap.version).toBe('3');
    expect(snap.created_at).toBe(5000);
    expect(snap.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.nodes).toEqual(core.nodes);
    expect(snap.edges).toEqual(core.edges);
  });
});
