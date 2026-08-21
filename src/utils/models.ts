import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { ModelItem } from '../types/index.js';

export interface UpstreamModel extends ModelItem {}

function getProjectRootDir(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

const MODELS_FILE_PATH = path.join(getProjectRootDir(), 'models.json');

const DEFAULT_MODELS: ModelItem[] = [
  { id: 'claude-sonnet-5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'Claude Sonnet 5', context_length: 1000000, supports_vision: true },
  { id: 'claude-sonnet-4-6', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'Claude Sonnet 4.6', context_length: 1000000 },
  { id: 'gpt-5.6-sol', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'GPT 5.6 Sol', context_length: 1000000 },
  { id: 'deepseek/deepseek-v4-pro', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'deepseek', name: 'DeepSeek V4 Pro' },
  { id: 'poolside/laguna-s-2.1-free', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'poolside', name: 'Poolside Laguna S 2.1 Free' },
  { id: 'google/gemini-3.6-flash', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'google', name: 'Gemini 3.6 Flash' },
  { id: 'xai/grok-4.5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'xai', name: 'Grok 4.5' },
];

let cachedModels: ModelItem[] = loadPersistedModels();

function loadPersistedModels(): ModelItem[] {
  try {
    if (fs.existsSync(MODELS_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(MODELS_FILE_PATH, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err: any) {
    logger.warn(`[MODELS] Could not load models.json: ${err.message}`);
  }
  savePersistedModels(DEFAULT_MODELS);
  return DEFAULT_MODELS;
}

function savePersistedModels(models: ModelItem[]): void {
  try {
    fs.writeFileSync(MODELS_FILE_PATH, JSON.stringify(models, null, 2), 'utf-8');
  } catch (err: any) {
    logger.error(`[MODELS] Error saving models.json: ${err.message}`);
  }
}

function hasModelsChanged(existing: ModelItem[], fresh: ModelItem[]): boolean {
  if (existing.length !== fresh.length) return true;
  const existingIds = new Set(existing.map(m => m.id));
  return fresh.some(m => !existingIds.has(m.id));
}

export function getCachedModels(): ModelItem[] {
  return cachedModels;
}

export async function fetchUpstreamModels(apiKey: string, ccVersion: string): Promise<ModelItem[]> {
  const config = loadConfig();
  if (!apiKey) return cachedModels;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'cli',
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
  };

  try {
    const res = await fetch(`${config.ccApiBase}/provider/v1/models`, { method: 'GET', headers });
    if (res.ok) {
      const data: any = await res.json();
      let rawList: any[] = [];
      if (Array.isArray(data)) rawList = data;
      else if (Array.isArray(data.data)) rawList = data.data;
      else if (Array.isArray(data.models)) rawList = data.models;

      if (rawList.length > 0) {
        const freshModels: ModelItem[] = rawList.map((item: any) => {
          if (typeof item === 'string') {
            return {
              id: item,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: item.split('/')[0] || 'command-code',
            };
          }
          return {
            id: item.id || item.name,
            object: 'model',
            created: item.created || Math.floor(Date.now() / 1000),
            owned_by: item.owned_by || item.provider || (item.id ? String(item.id).split('/')[0] : 'command-code'),
            name: item.name,
            context_length: item.context_length || item.contextWindow,
            reasoning_efforts: item.reasoning_efforts || item.reasoningEfforts,
            supports_vision: item.supports_vision ?? item.supportsVision,
          };
        });

        if (hasModelsChanged(cachedModels, freshModels)) {
          cachedModels = freshModels;
          savePersistedModels(cachedModels);
          logger.info(`[MODELS] Synchronized ${cachedModels.length} models into models.json`);
        } else {
          logger.info(`[MODELS] Model catalog verified (${cachedModels.length} models up to date).`);
        }
        return cachedModels;
      }
    }
  } catch (err: any) {
    logger.warn(`[MODELS] Upstream model fetch failed: ${err.message}`);
  }

  return cachedModels;
}

/**
 * Fuzzy-resolve a requested model id to a known upstream model.
 * Exact → prefix-strip → suffix → partial → family keyword → first model.
 */
export function resolveModelName(requestedModel: string): string {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return cachedModels[0]?.id || 'claude-sonnet-5';
  }

  const raw = requestedModel.trim();
  const available = getCachedModels();

  if (available.some(m => m.id === raw)) return raw;

  let clean = raw.replace(/^([a-z0-9_-]+)[:\/]/i, '').trim();
  if (available.some(m => m.id === clean)) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${clean}'`);
    return clean;
  }

  const lowerClean = clean.toLowerCase();
  const endsWithMatch = available.find(
    m =>
      m.id.toLowerCase() === lowerClean ||
      m.id.toLowerCase().endsWith('/' + lowerClean) ||
      (m.name && m.name.toLowerCase() === lowerClean)
  );
  if (endsWithMatch) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${endsWithMatch.id}'`);
    return endsWithMatch.id;
  }

  const partialMatch = available.find(m => m.id.toLowerCase().includes(lowerClean));
  if (partialMatch) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${partialMatch.id}'`);
    return partialMatch.id;
  }

  const familyRules: Array<[RegExp, string[]]> = [
    [/sonnet|claude/, ['sonnet', 'claude']],
    [/gpt-4|gpt-5|gpt/, ['gpt-5', 'gpt-4', 'gpt']],
    [/o3|o1|reason/, ['o3', 'o1']],
    [/gemini|flash/, ['gemini', 'flash']],
  ];
  for (const [test, candidates] of familyRules) {
    if (test.test(lowerClean)) {
      for (const kw of candidates) {
        const hit = available.find(m => m.id.toLowerCase().includes(kw));
        if (hit) {
          logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${hit.id}'`);
          return hit.id;
        }
      }
    }
  }

  const defaultModel = available[0]?.id || 'claude-sonnet-5';
  logger.warn(`[MODELS] Model '${requestedModel}' not found upstream. Falling back to '${defaultModel}'.`);
  return defaultModel;
}

/** Look up the reasoning-effort tiers the upstream model supports. */
export function getReasoningEfforts(modelId: string): string[] | undefined {
  const m = cachedModels.find(m => m.id === modelId);
  return m?.reasoning_efforts;
}
