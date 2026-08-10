import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

export interface ModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name?: string;
  context_length?: number;
  reasoning_efforts?: string[];
  supports_vision?: boolean;
}

function getProjectRootDir(): string {
  if (process.execPath.toLowerCase().includes('commandcode-proxy-v3') || (process as any).pkg) {
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
      const content = fs.readFileSync(MODELS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
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

  const modelEndpoints = [
    `${config.ccApiBase}/provider/v1/models`,
    `${config.ccApiBase}/v1/models`,
    `${config.ccApiBase}/alpha/models`,
  ];

  for (const endpoint of modelEndpoints) {
    try {
      const res = await fetch(endpoint, { method: 'GET', headers });
      if (res.ok) {
        const data: any = await res.json();
        let rawList: any[] = [];
        if (Array.isArray(data)) rawList = data;
        else if (Array.isArray(data.data)) rawList = data.data;
        else if (Array.isArray(data.models)) rawList = data.models;

        if (rawList.length > 0) {
          const freshModels: ModelItem[] = rawList.map(item => {
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
              owned_by: item.owned_by || item.provider || (item.id ? item.id.split('/')[0] : 'command-code'),
              name: item.name,
              context_length: item.context_length || item.contextWindow,
              reasoning_efforts: item.reasoning_efforts || item.reasoningEfforts,
              supports_vision: item.supports_vision ?? item.supportsVision,
            };
          });

          if (hasModelsChanged(cachedModels, freshModels)) {
            cachedModels = freshModels;
            savePersistedModels(cachedModels);
            logger.info(`[MODELS] Synchronized and updated ${cachedModels.length} models in models.json`);
          } else {
            logger.info(`[MODELS] Model catalog verified on startup (${cachedModels.length} models up to date, no file update needed).`);
          }
          return cachedModels;
        }
      }
    } catch (err: any) {
      logger.warn(`[MODELS] Failed endpoint ${endpoint}: ${err.message}`);
    }
  }

  return cachedModels;
}

export function resolveModelName(requestedModel: string): string {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return cachedModels[0]?.id || 'claude-sonnet-5';
  }

  const raw = requestedModel.trim();
  const available = getCachedModels();

  if (available.some(m => m.id === raw)) {
    return raw;
  }

  let clean = raw.replace(/^([a-z0-9_-]+)[:\/]/i, '');
  clean = clean.trim();

  if (available.some(m => m.id === clean)) {
    logger.info(`[MODELS] Resolved requested model '${requestedModel}' -> '${clean}'`);
    return clean;
  }

  const lowerClean = clean.toLowerCase();
  const endsWithMatch = available.find(m => 
    m.id.toLowerCase() === lowerClean || 
    m.id.toLowerCase().endsWith('/' + lowerClean) ||
    (m.name && m.name.toLowerCase() === lowerClean)
  );
  if (endsWithMatch) {
    logger.info(`[MODELS] Resolved requested model '${requestedModel}' -> '${endsWithMatch.id}'`);
    return endsWithMatch.id;
  }

  const partialMatch = available.find(m => m.id.toLowerCase().includes(lowerClean));
  if (partialMatch) {
    logger.info(`[MODELS] Resolved requested model '${requestedModel}' -> '${partialMatch.id}'`);
    return partialMatch.id;
  }

  if (lowerClean.includes('sonnet') || lowerClean.includes('claude')) {
    const sonnet = available.find(m => m.id.toLowerCase().includes('sonnet') || m.id.toLowerCase().includes('claude'));
    if (sonnet) {
      logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${sonnet.id}'`);
      return sonnet.id;
    }
  }

  if (lowerClean.includes('gpt-4') || lowerClean.includes('gpt-5') || lowerClean.includes('gpt')) {
    const gpt = available.find(m => m.id.toLowerCase().includes('gpt-5') || m.id.toLowerCase().includes('gpt-4') || m.id.toLowerCase().includes('gpt'));
    if (gpt) {
      logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${gpt.id}'`);
      return gpt.id;
    }
  }

  if (lowerClean.includes('o3') || lowerClean.includes('o1') || lowerClean.includes('reason')) {
    const o3 = available.find(m => m.id.toLowerCase().includes('o3') || m.id.toLowerCase().includes('o1'));
    if (o3) {
      logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${o3.id}'`);
      return o3.id;
    }
  }

  if (lowerClean.includes('gemini') || lowerClean.includes('flash')) {
    const gemini = available.find(m => m.id.toLowerCase().includes('gemini') || m.id.toLowerCase().includes('flash'));
    if (gemini) {
      logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${gemini.id}'`);
      return gemini.id;
    }
  }

  const defaultModel = available[0]?.id || 'claude-sonnet-5';
  logger.warn(`[MODELS] Model '${requestedModel}' not found upstream. Falling back to active model '${defaultModel}'.`);
  return defaultModel;
}
