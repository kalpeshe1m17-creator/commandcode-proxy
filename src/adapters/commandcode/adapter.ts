import crypto from 'node:crypto';
import {
  OpenAIChatRequest,
  AnthropicRequest,
  CCRequestBody,
  CCMessage,
  CCContentPart,
  CCTool,
  CCToolChoice,
  CCEvent,
  StreamEncoderState,
} from '../../types/index.js';
import { resolveModelName } from '../../utils/models.js';
import { loadConfig } from '../../utils/config.js';

export function toWirePermissionMode(mode?: string): 'auto-accept' | 'standard' | 'plan' {
  if (mode === 'bypass' || mode === 'auto-accept') return 'auto-accept';
  if (mode === 'plan') return 'plan';
  return 'standard';
}

export class CommandCodeAdapter {
  private static convertTools(tools?: OpenAIChatRequest['tools']): CCTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const sliced = tools.slice(0, 15);
    return sliced.map(t => {
      if (t.type === 'custom' && t.custom) {
        return {
          name: t.custom.name,
          description: t.custom.description || '',
          input_schema: t.custom.parameters || { type: 'object', properties: {} },
          strict: false,
        };
      }
      return {
        name: t.function!.name,
        description: t.function!.description || '',
        input_schema: t.function!.parameters || { type: 'object', properties: {} },
        strict: t.function!.strict ?? false,
      };
    });
  }

  private static convertToolChoice(tc?: OpenAIChatRequest['tool_choice']): CCToolChoice | undefined {
    if (!tc || tc === 'auto' || tc === 'none') return undefined;
    if (tc === 'required') return { type: 'any' };
    if (typeof tc === 'object' && tc.type === 'function') {
      return { type: 'tool', name: tc.function.name };
    }
    if (typeof tc === 'object' && tc.type === 'allowed_tools') {
      return { type: 'allowed_tools', mode: tc.mode, tools: tc.tools };
    }
    return undefined;
  }

  private resolveReasoningEffort(model: string, requested?: any, thinkingConfig?: any): string | undefined {
    if (thinkingConfig && thinkingConfig.type === 'enabled') {
      const budget = thinkingConfig.budget_tokens ?? 2048;
      if (budget >= 16000) return 'max';
      if (budget >= 8000) return 'high';
      if (budget >= 4000) return 'medium';
      return 'low';
    }

    if (requested == null) return undefined;

    const levelMap: Record<string | number, string> = {
      0: 'none',
      1: 'minimal',
      2: 'low',
      3: 'medium',
      4: 'high',
      5: 'xhigh',
      6: 'max',
      7: 'max',
      none: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    };

    return levelMap[requested] || String(requested);
  }

  private pruneDanglingTools(messages: CCMessage[]): CCMessage[] {
    const validIds = new Set<string>();
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool-call' && part.toolCallId) {
            validIds.add(part.toolCallId);
          }
        }
      }
    }

    const pruned: CCMessage[] = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        pruned.push(msg);
        continue;
      }
      const filtered = msg.content.filter(
        part =>
          (part.type !== 'tool-call' && part.type !== 'tool-result') ||
          (part.toolCallId != null && validIds.has(part.toolCallId))
      );
      if (filtered.length > 0) {
        pruned.push({ role: msg.role, content: filtered });
      }
    }
    return pruned;
  }

  translateOpenAIRequest(req: OpenAIChatRequest): CCRequestBody {
    let system = '';
    const ccMessages: CCMessage[] = [];
    const toolNameById = new Map<string, string>();

    for (const m of req.messages || []) {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id && tc.function) toolNameById.set(tc.id, tc.function.name);
        }
      }
    }

    for (const m of req.messages || []) {
      if (m.role === 'system' || m.role === 'developer') {
        const textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        system = system ? `${system}\n\n${textContent}` : textContent;
      } else if (m.role === 'user') {
        if (typeof m.content === 'string') {
          ccMessages.push({ role: 'user', content: m.content });
        } else if (Array.isArray(m.content)) {
          const parts: CCContentPart[] = [];
          for (const p of m.content) {
            if (p.type === 'text') {
              parts.push({ type: 'text', text: p.text || '' });
            } else if (p.type === 'image_url') {
              parts.push({ type: 'image', image: p.image_url?.url || '' });
            }
          }
          ccMessages.push({ role: 'user', content: parts.length > 0 ? parts : '' });
        }
      } else if (m.role === 'assistant') {
        const parts: CCContentPart[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        }
        if (m.reasoning_content) {
          parts.push({ type: 'reasoning', text: m.reasoning_content });
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            let parsedInput = {};
            try {
              parsedInput = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {
              parsedInput = { raw: tc.function.arguments };
            }
            parts.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: parsedInput,
            });
          }
        }
        ccMessages.push({ role: 'assistant', content: parts.length > 0 ? parts : '' });
      } else if (m.role === 'tool' || m.role === 'function') {
        const toolName = toolNameById.get(m.tool_call_id || '') || m.name || 'tool';
        const outputVal = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        ccMessages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.tool_call_id || '',
              toolName,
              output: { type: 'text', value: outputVal },
            },
          ],
        });
      }
    }

    const finalMessages = this.pruneDanglingTools(ccMessages);
    const targetModel = resolveModelName(req.model);
    const convertedTools = CommandCodeAdapter.convertTools(req.tools);
    const config = loadConfig();
    const modeSetting = toWirePermissionMode(config.permissionMode);

    const requestBody: CCRequestBody = {
      config: {
        date: new Date().toISOString().split('T')[0],
        environment: process.platform,
        workingDir: process.cwd(),
        availableTools: [],
        structure: [],
        isGitRepo: true,
        currentBranch: 'master',
        mainBranch: 'master',
        gitStatus: 'Working tree clean',
        recentCommits: [],
        os: process.platform === 'win32' ? 'windows' : process.platform,
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
      },
      memory: null,
      taste: null,
      skills: null,
      permissionMode: modeSetting,
      threadId: crypto.randomUUID(),
      params: {
        model: targetModel,
        messages: finalMessages,
        system: system || undefined,
        ...(convertedTools && convertedTools.length > 0 ? { tools: convertedTools } : {}),
        ...(req.tool_choice ? { tool_choice: CommandCodeAdapter.convertToolChoice(req.tool_choice) } : {}),
        stream: true,
        max_tokens: req.max_completion_tokens ?? req.max_tokens ?? 64000,
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.top_p != null ? { top_p: req.top_p } : {}),
        reasoning_effort: this.resolveReasoningEffort(targetModel, req.reasoning_effort, req.thinking),
      },
    };

    return requestBody;
  }

  translateAnthropicRequest(req: AnthropicRequest): CCRequestBody {
    const openAIReq: OpenAIChatRequest = {
      model: req.model,
      messages: [],
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      stream: req.stream,
      tools: req.tools,
      tool_choice: req.tool_choice,
      thinking: req.thinking,
    };

    if (req.system) {
      const systemStr = typeof req.system === 'string' ? req.system : JSON.stringify(req.system);
      openAIReq.messages.push({ role: 'system', content: systemStr });
    }

    for (const m of req.messages || []) {
      openAIReq.messages.push({
        role: m.role,
        content: m.content,
      });
    }

    return this.translateOpenAIRequest(openAIReq);
  }

  createStreamEncoderState(): StreamEncoderState {
    return {
      id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
      created: Math.floor(Date.now() / 1000),
      toolCallIndex: 0,
      toolCallIdToIndex: new Map<string, number>(),
      sawFinish: false,
      promptTokens: 0,
      completionTokens: 0,
      thinkingState: 'none',
    };
  }

  encodeOpenAIChunk(event: CCEvent, state: StreamEncoderState, modelName: string): string[] {
    const chunks: string[] = [];

    if (event.type === 'start') {
      chunks.push(
        `data: ${JSON.stringify({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      return chunks;
    }

    if (event.type === 'reasoning-delta' && event.text) {
      chunks.push(
        `data: ${JSON.stringify({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: event.text },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      return chunks;
    }

    if (event.type === 'text-delta' && event.text) {
      let rawText = event.text;

      // Extract real-time <think>...</think> tags
      if (rawText.includes('<think>') || state.thinkingState === 'in_think') {
        if (rawText.includes('<think>') && rawText.includes('</think>')) {
          const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            const reasoningPart = thinkMatch[1];
            const cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/, '');
            if (reasoningPart) {
              chunks.push(
                `data: ${JSON.stringify({
                  id: state.id,
                  object: 'chat.completion.chunk',
                  created: state.created,
                  model: modelName,
                  choices: [{ index: 0, delta: { reasoning_content: reasoningPart }, finish_reason: null }],
                })}\n\n`
              );
            }
            rawText = cleanText;
          }
        } else if (rawText.includes('<think>')) {
          state.thinkingState = 'in_think';
          const thinkContent = rawText.split('<think>')[1] || '';
          if (thinkContent) {
            chunks.push(
              `data: ${JSON.stringify({
                id: state.id,
                object: 'chat.completion.chunk',
                created: state.created,
                model: modelName,
                choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
              })}\n\n`
            );
          }
          return chunks;
        } else if (rawText.includes('</think>')) {
          state.thinkingState = 'done';
          const parts = rawText.split('</think>');
          if (parts[0]) {
            chunks.push(
              `data: ${JSON.stringify({
                id: state.id,
                object: 'chat.completion.chunk',
                created: state.created,
                model: modelName,
                choices: [{ index: 0, delta: { reasoning_content: parts[0] }, finish_reason: null }],
              })}\n\n`
            );
          }
          rawText = parts[1] || '';
        } else if (state.thinkingState === 'in_think') {
          chunks.push(
            `data: ${JSON.stringify({
              id: state.id,
              object: 'chat.completion.chunk',
              created: state.created,
              model: modelName,
              choices: [{ index: 0, delta: { reasoning_content: rawText }, finish_reason: null }],
            })}\n\n`
          );
          return chunks;
        }
      }

      if (rawText) {
        chunks.push(
          `data: ${JSON.stringify({
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: rawText },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
      }
      return chunks;
    }

    if (event.type === 'tool-call-delta' || event.type === 'tool-call') {
      const toolCallId = event.toolCallId || `call_${crypto.randomUUID().slice(0, 8)}`;
      let idx = state.toolCallIdToIndex.get(toolCallId);
      if (idx === undefined) {
        idx = state.toolCallIndex++;
        state.toolCallIdToIndex.set(toolCallId, idx);
      }

      chunks.push(
        `data: ${JSON.stringify({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id: toolCallId,
                    type: 'function',
                    function: {
                      name: event.toolName || event.name || 'tool',
                      arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.input || {}),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      return chunks;
    }

    if (event.type === 'finish') {
      state.sawFinish = true;
      const finishReason = event.finishReason || (state.toolCallIdToIndex.size > 0 ? 'tool_calls' : 'stop');
      chunks.push(
        `data: ${JSON.stringify({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        })}\n\n`
      );
      chunks.push('data: [DONE]\n\n');
      return chunks;
    }

    return chunks;
  }
}
