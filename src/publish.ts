// ============================================================
// PUBLISH — serialize an AtlasCore into a versioned, content-addressed snapshot
//
// Pure. The hash is a change-detector, not a cryptographic guarantee (32-bit
// FNV-1a over a canonical — recursively key-sorted — JSON encoding, reusing
// the same hash primitive the encoder already uses): two snapshots with the
// same hash have (with overwhelming probability) the same content, which is
// all a "did the graph actually change since last publish?" check needs.
// version/created_at are supplied by the caller (the CLI in scripts/publish.ts)
// since stamping wall-clock time is the one thing this module deliberately
// does NOT do itself — that would make buildAtlas's output depend on when it
// ran, breaking the "same input → identical atlas" guarantee tests rely on.
// ============================================================

import { fnv1a } from './core/hyper';
import type { AtlasCore } from './cartographer';

export interface AtlasSnapshot extends AtlasCore {
  version: string;
  created_at: number;   // epoch ms, caller-stamped
  hash: string;
}

// Recursively sort object keys so semantically-identical atlases (built from
// the same events, same opts) always serialize byte-for-byte identically —
// key insertion order must not affect the hash.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonical(value));
}

// Two rounds of FNV-1a over 16-char chunks, concatenated to hex — cheap way
// to widen the 32-bit primitive's effective space for a content hash without
// pulling in a crypto dependency (the core's zero-runtime-dependency rule
// applies here too, not just to the geometry).
function contentHash(s: string): string {
  const a = fnv1a(s);
  const b = fnv1a(s.split('').reverse().join(''));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function serializeAtlas(core: AtlasCore, meta: { version: string; created_at: number }): AtlasSnapshot {
  const withMeta = { ...core, version: meta.version, created_at: meta.created_at };
  const hash = contentHash(canonicalJSON(withMeta));
  return { ...withMeta, hash };
}
