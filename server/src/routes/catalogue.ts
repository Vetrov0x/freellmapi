import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';

// Catalogue sync — "sync from provider /models" (Q-298 / INC-20260704-002).
// Closes the model-id drift CLASS: a provider renaming/removing models used to
// leave dead ids in our catalogue (cerebras 404 x168/day) and live ones missing
// (google gemma-3-27b-it, 14400 rpd, absent). One mechanism for every platform.
//
// Policy (Дозор autonomy law): NOT on a timer. Invoked explicitly (operator or
// a ratified runbook step). GET /diff is read-only; POST /sync mutates:
//   - live upstream, missing here      -> INSERT (enabled, bottom rank)
//   - in catalogue, gone upstream      -> UPDATE enabled=0 (never DELETE)
//   - present both sides               -> untouched (manual limits preserved)

export const catalogueRouter = Router();

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function listLiveModelIds(platform: string, apiKey: string): Promise<string[]> {
  if (platform === 'google') {
    // AI Studio: paginated, filter to text-generation models
    const ids: string[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = `${GOOGLE_BASE}/models?pageSize=200&key=${apiKey}` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`google /models HTTP ${res.status}`);
      const data = await res.json() as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of data.models ?? []) {
        if (!m.name) continue;
        if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
        ids.push(m.name.replace(/^models\//, ''));
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return ids;
  }
  // OpenAI-compatible platforms: {baseUrl}/models with Bearer
  const provider = getProvider(platform as never) as unknown as { baseUrl?: string } | undefined;
  const baseUrl = provider?.baseUrl;
  if (!baseUrl) throw new Error(`platform '${platform}' has no listable provider baseUrl`);
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`${platform} /models HTTP ${res.status}`);
  const data = await res.json() as { data?: { id?: string }[] };
  return (data.data ?? []).map(m => m.id).filter((x): x is string => Boolean(x));
}

function getDecryptedKey(platform: string): string {
  const db = getDb();
  const row = db.prepare(
    `SELECT encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = ? AND enabled = 1 ORDER BY id DESC LIMIT 1`,
  ).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) throw new Error(`no enabled api key for platform '${platform}'`);
  return decrypt(row.encrypted_key, row.iv, row.auth_tag);
}

interface CatalogueDiff {
  platform: string;
  live_count: number;
  to_add: string[];
  to_disable: string[];
  unchanged: number;
}

async function computeDiff(platform: string): Promise<CatalogueDiff> {
  const apiKey = getDecryptedKey(platform);
  const live = await listLiveModelIds(platform, apiKey);
  const liveSet = new Set(live);
  const db = getDb();
  const rows = db.prepare(
    'SELECT model_id, enabled FROM models WHERE platform = ?',
  ).all(platform) as { model_id: string; enabled: number }[];
  const known = new Set(rows.map(r => r.model_id));
  return {
    platform,
    live_count: live.length,
    to_add: live.filter(id => !known.has(id)),
    to_disable: rows.filter(r => r.enabled === 1 && !liveSet.has(r.model_id)).map(r => r.model_id),
    unchanged: rows.filter(r => liveSet.has(r.model_id)).length,
  };
}

// Read-only drift report (Дозор can call this without mutating anything)
catalogueRouter.get('/diff/:platform', async (req: Request, res: Response) => {
  try {
    res.json(await computeDiff(String(req.params.platform)));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// Apply: add live models (bottom rank), disable dead ones. Never deletes.
catalogueRouter.post('/sync/:platform', async (req: Request, res: Response) => {
  try {
    const diff = await computeDiff(String(req.params.platform));
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
       VALUES (?, ?, ?, 900, 900)`,
    );
    const disable = db.prepare(
      'UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?',
    );
    const apply = db.transaction(() => {
      for (const id of diff.to_add) insert.run(diff.platform, id, id);
      for (const id of diff.to_disable) disable.run(diff.platform, id);
    });
    apply();
    res.json({ ...diff, applied: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});
