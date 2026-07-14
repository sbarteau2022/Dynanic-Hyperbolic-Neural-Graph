#!/usr/bin/env tsx
// ============================================================
// SYNC EVENTS — pull the worker's append-only co-recall ledger to the device.
//
//   ATLAS_PULL_URL=https://elle-worker... ATLAS_SERVICE_KEY=... npm run sync-events
//
// GETs /api/atlas/events (service-key gated; the ledger elle-worker's
// recalls append to in src/atlas-events.ts), pages through everything after
// the stored cursor, and appends the new events to data/events.json in the
// cartographer's MemEvent shape. The cursor lives in data/cursor.json, so
// re-running is idempotent — an event is fetched once, ever. This pull and
// publish.ts's push are the device's only two network calls, and both are
// device-initiated: the worker never reaches into this machine.
//
// The full loop, on device:
//   npm run sync-events     # ledger → data/events.json
//   npm run publish-atlas   # events → atlas (regulated) → stop-loss → push
// ============================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MemEvent } from '../src/core/events';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const EVENTS_PATH = process.env.ATLAS_EVENTS_PATH || path.join(DATA_DIR, 'events.json');
const CURSOR_PATH = path.join(DATA_DIR, 'cursor.json');

interface LedgerRow { id: number; kind: string; src: string; dst: string; weight: number; ts: number }
interface LedgerPage { events: LedgerRow[]; cursor: number; more: boolean }

async function readJSON<T>(p: string): Promise<T | null> {
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')) as T; } catch { return null; }
}

async function main() {
  const baseUrl = process.env.ATLAS_PULL_URL || process.env.ATLAS_PUSH_URL;
  const key = process.env.ATLAS_SERVICE_KEY;
  if (!baseUrl || !key) {
    console.error('set ATLAS_PULL_URL (or ATLAS_PUSH_URL) and ATLAS_SERVICE_KEY to pull the ledger.');
    process.exitCode = 1;
    return;
  }

  let cursor = (await readJSON<{ cursor: number }>(CURSOR_PATH))?.cursor ?? 0;
  const existing = (await readJSON<MemEvent[]>(EVENTS_PATH)) ?? [];
  const pulled: MemEvent[] = [];

  for (let page = 0; page < 1000; page++) {   // hard backstop, not an expected bound
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/atlas/events?since=${cursor}&limit=500`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.error(`pull failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    const data = (await res.json()) as LedgerPage;
    for (const e of data.events) {
      pulled.push({ kind: e.kind as MemEvent['kind'], src: e.src, dst: e.dst, weight: e.weight, ts: e.ts });
    }
    cursor = data.cursor;
    if (!data.more) break;
  }

  if (!pulled.length) {
    console.log(`ledger is quiet — cursor ${cursor}, ${existing.length} events already local.`);
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(EVENTS_PATH, JSON.stringify([...existing, ...pulled], null, 2));
  await writeFile(CURSOR_PATH, JSON.stringify({ cursor }));
  console.log(`pulled ${pulled.length} new events (cursor → ${cursor}); ${existing.length + pulled.length} total in ${EVENTS_PATH}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
