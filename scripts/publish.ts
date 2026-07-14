#!/usr/bin/env tsx
// ============================================================
// PUBLISH CLI — the on-device entry point.
//
//   npm run publish-atlas [-- --in path/to/events.json]
//
// Reads the local append-only event log, folds it through the cartographer
// (events → edges → hyper/torus/structure/product, warm-started from the
// last published atlas if one exists), writes the versioned snapshot to
// ./atlas/, and — only if ATLAS_PUSH_URL + ATLAS_SERVICE_KEY are set in the
// environment — POSTs the raw numeric snapshot to elle-worker's
// /api/atlas/ingest so Elle can embed it into her own memory. That push is
// the ONLY network call this script makes, and it is one-directional
// (device → worker); nothing here ever asks the worker for anything, and
// nothing in elle-worker calls back into this repo. The computation itself
// never leaves the device.
// ============================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildAtlas, type CartographerOpts } from '../src/cartographer';
import { serializeAtlas, type AtlasSnapshot } from '../src/publish';
import { regulate, stopLoss, recoveryRate, type BuildRecord } from '../src/core/recovery';
import type { MemEvent } from '../src/core/events';

const ROOT = path.resolve(import.meta.dirname, '..');
const ATLAS_DIR = path.join(ROOT, 'atlas');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readJSON<T>(p: string): Promise<T | null> {
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')) as T; } catch { return null; }
}

async function main() {
  const eventsPath = argValue('--in') || process.env.ATLAS_EVENTS_PATH || path.join(ROOT, 'data', 'events.json');
  const events = await readJSON<MemEvent[]>(eventsPath);
  if (!events || !events.length) {
    console.error(`no events at ${eventsPath} — nothing to publish. See data/events.example.json for the shape.`);
    process.exitCode = 1;
    return;
  }

  const prior = await readJSON<AtlasSnapshot>(path.join(ATLAS_DIR, 'latest.json'));
  const history = (await readJSON<BuildRecord[]>(path.join(ATLAS_DIR, 'history.json'))) ?? [];

  // The regulating function: the drift history of past builds chooses this
  // build's anneal (more recent drift → more relax epochs at a gentler lr).
  const relax = regulate(history);
  const opts: CartographerOpts = prior
    ? { prior: prior.hyper.points, relaxEpochs: relax.relaxEpochs, lr: relax.lr }
    : {};

  const core = buildAtlas(events, opts);
  const version = String((prior ? Number(prior.version) || 0 : 0) + 1);
  const snapshot = serializeAtlas(core, { version, created_at: Date.now() });

  const drift = (snapshot.hyper as { drift?: { mean: number; max: number } }).drift;
  const record: BuildRecord = {
    version: snapshot.version, created_at: snapshot.created_at,
    drift_mean: drift?.mean ?? 0, drift_max: drift?.max ?? 0,
    new_nodes: (snapshot.hyper as { new_nodes?: string[] }).new_nodes?.length ?? snapshot.nodes.length,
  };
  const nextHistory = [...history, record].slice(-50);
  const driftSeries = nextHistory.map((h) => h.drift_mean);

  // The stop-loss: a bad build is kept locally but never propagates to Elle.
  const verdict = stopLoss({ driftSeries, disagreements: snapshot.product.disagreements as { same_rhythm_diff_lineage?: Array<{ a: string; b: string; ball: number; torus: number }> } });

  await mkdir(ATLAS_DIR, { recursive: true });
  await writeFile(path.join(ATLAS_DIR, `${snapshot.hash}.json`), JSON.stringify(snapshot, null, 2));
  await writeFile(path.join(ATLAS_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));
  await writeFile(path.join(ATLAS_DIR, 'history.json'), JSON.stringify(nextHistory, null, 2));

  const summary = {
    version: snapshot.version,
    hash: snapshot.hash,
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    cycle_rank: snapshot.structure.invariants.cycle_rank,
    mix: snapshot.product.mix,
    temporal: snapshot.temporal,
    drift: snapshot.temporal ? drift : undefined,
    relax: snapshot.temporal ? relax : undefined,
    recovery_rate: recoveryRate(driftSeries),
    stop_loss: verdict,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (verdict.triggered) {
    console.error(`STOP-LOSS: snapshot kept locally, NOT pushed — ${verdict.reasons.map((r) => r.kind).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const pushUrl = process.env.ATLAS_PUSH_URL;
  const pushKey = process.env.ATLAS_SERVICE_KEY;
  if (pushUrl && pushKey) {
    const res = await fetch(`${pushUrl.replace(/\/$/, '')}/api/atlas/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pushKey}` },
      body: JSON.stringify({ snapshot }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`push to ${pushUrl} failed: ${res.status} ${body.slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`pushed to ${pushUrl}: ${body.slice(0, 300)}`);
  } else {
    console.log('ATLAS_PUSH_URL / ATLAS_SERVICE_KEY not set — snapshot written locally only, not pushed.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
