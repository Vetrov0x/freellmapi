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
// Policy (Дозор autonomy law): the CATALOGUE IS IVAN-GATED. This route NEVER
// mutates unless the caller passes ?apply=true. `apply=false` (the DEFAULT)
// returns the diff and changes nothing — it is a PROPOSAL only. GET /diff is
// likewise read-only. Classification per operator brief:
//   - ADD   : live upstream (chat-capable), missing here      -> INSERT (bottom rank)
//   - PRUNE : in catalogue, absent from provider's live list  -> UPDATE enabled=0 (never DELETE)
//   - KEEP  : present both sides                              -> untouched (manual limits preserved)
//
// Security: the provider key is decrypted in-process and used only to sign the
// upstream request. It is never logged, returned, or embedded in an error
// message (google's key rides in the query string, so errors surface only the
// HTTP status, never the URL).

export const catalogueRouter = Router();

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface LiveModels {
  // chat-routable ids (google: supports generateContent; openai-compat: all) —
  // the ADD candidate set, so we never add image/tts/music rows as chat routes.
  chatIds: string[];
  // every id the provider lists, regardless of modality — the PRESENCE set used
  // for PRUNE, so a live-but-non-chat model (google image/tts) is never falsely
  // flagged dead, and only genuinely-removed ids prune.
  allIds: string[];
}

async function listLiveModels(platform: string, apiKey: string): Promise<LiveModels> {
  if (platform === 'google') {
    // AI Studio ListModels: paginated. Collect ALL names for presence, and the
    // generateContent subset for chat-add candidates.
    const chatIds: string[] = [];
    const allIds: string[] = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const url = `${GOOGLE_BASE}/models?pageSize=200&key=${apiKey}` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const res = await fetch(url);
      // Never include the URL (carries the key) in the thrown message.
      if (!res.ok) throw new Error(`google /models HTTP ${res.status}`);
      const data = await res.json() as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of data.models ?? []) {
        if (!m.name) continue;
        const id = m.name.replace(/^models\//, '');
        allIds.push(id);
        if ((m.supportedGenerationMethods ?? []).includes('generateContent')) {
          chatIds.push(id);
        }
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return { chatIds, allIds };
  }
  // OpenAI-compatible platforms (cerebras, groq, sambanova, ...): {baseUrl}/models
  // with Bearer. No modality distinction — the whole list is chat-routable.
  const provider = getProvider(platform as never) as unknown as { baseUrl?: string } | undefined;
  const baseUrl = provider?.baseUrl;
  if (!baseUrl) throw new Error(`platform '${platform}' has no listable provider baseUrl`);
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`${platform} /models HTTP ${res.status}`);
  const data = await res.json() as { data?: { id?: string }[] };
  const ids = (data.data ?? []).map(m => m.id).filter((x): x is string => Boolean(x));
  return { chatIds: ids, allIds: ids };
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
  live_count: number;   // chat-routable models the provider serves live
  live_total: number;   // all models the provider lists (presence set)
  // Brief classification (ADD / PRUNE / KEEP):
  add: string[];                                   // live & chat-routable, not catalogued
  prune: string[];                                 // catalogued but absent upstream (dead ids)
  prune_active: string[];                          // subset of prune currently enabled=1 (what apply would newly disable)
  keep: number;                                    // catalogued & present upstream
  // Back-compat aliases (kept for any existing caller of GET /diff):
  to_add: string[];
  to_disable: string[];
  unchanged: number;
}

async function computeDiff(platform: string): Promise<CatalogueDiff> {
  const apiKey = getDecryptedKey(platform);
  const { chatIds, allIds } = await listLiveModels(platform, apiKey);
  const chatSet = new Set(chatIds);
  const allSet = new Set(allIds);
  const db = getDb();
  const rows = db.prepare(
    'SELECT model_id, enabled FROM models WHERE platform = ?',
  ).all(platform) as { model_id: string; enabled: number }[];
  const known = new Set(rows.map(r => r.model_id));

  const add = chatIds.filter(id => !known.has(id));
  const pruneRows = rows.filter(r => !allSet.has(r.model_id)); // absent upstream = dead, regardless of enabled
  const prune = pruneRows.map(r => r.model_id);
  const prune_active = pruneRows.filter(r => r.enabled === 1).map(r => r.model_id);
  const keep = rows.filter(r => allSet.has(r.model_id)).length;

  return {
    platform,
    live_count: chatSet.size,
    live_total: allSet.size,
    add,
    prune,
    prune_active,
    keep,
    // aliases
    to_add: add,
    to_disable: prune_active,
    unchanged: keep,
  };
}

// Read-only drift report (Дозор can call this without mutating anything).
catalogueRouter.get('/diff/:platform', async (req: Request, res: Response) => {
  try {
    res.json(await computeDiff(String(req.params.platform)));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// Sync. IVAN-GATED: mutates ONLY when ?apply=true. The default (apply absent or
// apply=false) is a dry-run PROPOSAL — it returns the diff and changes nothing.
// Apply = add live chat models (bottom rank), disable dead ones. Never deletes.
catalogueRouter.post('/sync/:platform', async (req: Request, res: Response) => {
  try {
    const applyRaw = (req.query.apply ?? (req.body && (req.body as { apply?: unknown }).apply));
    const apply = applyRaw === true || applyRaw === 'true';
    const diff = await computeDiff(String(req.params.platform));

    if (!apply) {
      // Propose-only. Nothing is written. This is the DEFAULT.
      res.json({ ...diff, applied: false, mode: 'propose' });
      return;
    }

    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
       VALUES (?, ?, ?, 900, 900)`,
    );
    const disable = db.prepare(
      'UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?',
    );
    const applyTxn = db.transaction(() => {
      for (const id of diff.add) insert.run(diff.platform, id, id);
      for (const id of diff.prune_active) disable.run(diff.platform, id);
    });
    applyTxn();
    res.json({ ...diff, applied: true, mode: 'apply' });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});
