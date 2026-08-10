import { Readable } from 'node:stream';
import { CCRequestBody } from '../../types/index.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export function buildHeaders(apiKey: string, ccVersion: string, body: CCRequestBody): Record<string, string> {
  const sessionId = body.threadId;
  const baseDir = (String(body.config?.workingDir || process.cwd())).split(/[/\\]/).filter(Boolean).pop() ?? 'commandcode-proxy';
  const projectSlug = baseDir.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'commandcode-proxy';

  return {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
    'x-session-id': sessionId || '',
    'x-project-slug': projectSlug,
    'x-taste-learning': 'false',
    'x-co-flag': 'false',
  };
}

export async function sendToCC(body: CCRequestBody, apiKey: string, abortSignal?: AbortSignal): Promise<Readable> {
  const config = loadConfig();
  const url = `${config.ccApiBase}/alpha/generate`;
  body.params.stream = true;

  const headers = buildHeaders(apiKey, config.ccVersion, body);
  const reqData = JSON.stringify(body);

  logger.info(`[UPSTREAM] POST -> ${url} | model: ${body.params.model} | permissionMode: ${body.permissionMode} | payload: ${reqData.length} bytes`);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: reqData,
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`[UPSTREAM] Error ${response.status} ${response.statusText}: ${errorText.slice(0, 300)}`);
    throw new Error(`Upstream returned error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('Upstream response body is null');
  }

  return Readable.fromWeb(response.body as any);
}
