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

export function toWirePermissionMode(mode?: string): 'auto-accept' | 'standard' | 'plan' {
  return 'auto-accept';
}

const Qn = ['low', 'medium', 'high', 'xhigh', 'max'];
const Xn = ['low', 'medium', 'high', 'xhigh'];
const Zn = ['low', 'medium', 'high'];
const er = ['high', 'max'];

const OFFICIAL_REASONING_MAP: Record<string, string[]> = {
  'claude-sonnet-5': Qn,
  'claude-sonnet-4-6': Qn,
  'claude-fable-5': Qn,
  'claude-opus-5': Qn,
  'claude-opus-4-8': Qn,
  'claude-opus-4-7': Qn,
  'gpt-5.6-sol': Qn,
  'gpt-5.6-terra': Qn,
  'gpt-5.6-luna': Qn,
  'gpt-5.5': Xn,
  'gpt-5.4': Xn,
  'gpt-5.3-codex': Xn,
  'gpt-5.4-mini': Zn,
  'deepseek/deepseek-v4-pro': er,
  'deepseek/deepseek-v4-flash': er,
  'zai-org/GLM-5.2': er,
  'google/gemini-3.6-flash': Zn,
  'google/gemini-3.5-flash': Zn,
  'google/gemini-3.5-flash-lite': Zn,
  'google/gemini-3.1-flash-lite': Zn,
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.5': Zn,
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
};

export class CommandCodeAdapter {
  private static convertTools(tools?: OpenAIChatRequest['tools']): CCTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const sliced = tools.slice(0, 15);
    // toWireTools per CLI source: only name, description, input_schema — NO strict field
    return sliced.map(t => {
      if (t.type === 'custom' && t.custom) {
        return {
          name: t.custom.name,
          description: t.custom.description || '',
          input_schema: t.custom.parameters || { type: 'object', properties: {} },
        };
      }
      return {
        name: t.function!.name,
        description: t.function!.description || '',
        input_schema: t.function!.parameters || { type: 'object', properties: {} },
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

    let supported = OFFICIAL_REASONING_MAP[model];
    if (!supported) {
      const modelLower = model.toLowerCase();
      if (
        modelLower.includes('deepseek') ||
        modelLower.includes('glm-') ||
        modelLower.includes('grok') ||
        modelLower.includes('reasoner') ||
        modelLower.includes('thinking') ||
        modelLower.includes('o1') ||
        modelLower.includes('o3') ||
        modelLower.includes('qwq') ||
        modelLower.includes('laguna') ||
        modelLower.includes('inkling') ||
        modelLower.includes('step') ||
        modelLower.includes('kimi') ||
        modelLower.includes('qwen') ||
        modelLower.includes('claude-sonnet') ||
        modelLower.includes('claude-opus') ||
        modelLower.includes('gpt-5')
      ) {
        supported = ['low', 'medium', 'high', 'xhigh', 'max'];
      }
    }

    if (!supported) return undefined;

    if (requested == null) {
      return supported.includes('medium') ? 'medium' : supported[0];
    }

    let effortStr = String(requested).toLowerCase();
    if (typeof requested === 'number') {
      if (requested >= 6) effortStr = 'ultra';
      else if (requested === 5) effortStr = 'max';
      else if (requested === 4) effortStr = 'high';
      else if (requested === 3) effortStr = 'medium';
      else if (requested === 2) effortStr = 'low';
      else effortStr = 'minimal';
    }

    if (supported.includes(effortStr)) return effortStr;

    const rankMap: Record<string, number> = {
      none: 0,
      minimal: 0,
      low: 1,
      medium: 2,
      high: 3,
      xhigh: 4,
      max: 5,
      ultra: 5,
    };

    const reqRank = rankMap[effortStr] ?? 2;
    const atOrBelow = supported.filter(e => (rankMap[e] ?? 2) <= reqRank);
    if (atOrBelow.length > 0) {
      return atOrBelow.reduce((best, e) => ((rankMap[e] ?? 2) > (rankMap[best] ?? 2) ? e : best));
    }
    return supported[0] || 'medium';
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
      permissionMode: 'auto-accept',
      threadId: crypto.randomUUID(),
      params: {
        model: targetModel,
        messages: finalMessages,
        system: system || undefined,
        ...(convertedTools && convertedTools.length > 0 ? { tools: convertedTools } : {}),
        ...(req.tool_choice ? { tool_choice: CommandCodeAdapter.convertToolChoice(req.tool_choice) } : {}),
        stream: true,
        max_tokens: req.max_completion_tokens ?? req.max_tokens ?? 64000, // JS=64e3 per CLI source
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
      hasEmittedText: false,
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

    if (event.type === 'error') {
      const errObj = event.error || {};
      const errMsg = errObj.message || errObj.code || (typeof errObj === 'string' ? errObj : '');
      if (errMsg && errMsg !== 'unknown') {
        state.hasEmittedText = true;
        chunks.push(
          `data: ${JSON.stringify({
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: `\n[Upstream Error: ${errMsg}]\n` },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
      }
      return chunks;
    }

    if (event.type === 'reasoning-delta') {
      const text = event.text || event.data?.text;
      if (text) {
        state.hasEmittedText = true;
        chunks.push(
          `data: ${JSON.stringify({
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: text },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
      }
      return chunks;
    }

    if (event.type === 'text-delta') {
      let rawText = event.text || event.data?.text || '';
      if (!rawText) return chunks;

      // Extract real-time <think>...</think> tags if present in text
      if (rawText.includes('<think>') || state.thinkingState === 'in_think') {
        if (rawText.includes('<think>') && rawText.includes('</think>')) {
          const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            const reasoningPart = thinkMatch[1];
            const cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/, '');
            if (reasoningPart) {
              state.hasEmittedText = true;
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
            state.hasEmittedText = true;
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
            state.hasEmittedText = true;
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
          state.hasEmittedText = true;
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
        state.hasEmittedText = true;
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

    if (event.type === 'tool-call') {
      // CLI source: h.toolCallId, h.toolName, h.input ?? h.args (no h.data wrapper)
      state.hasEmittedText = true;
      const toolCallId = (event.toolCallId as string) || `call_${crypto.randomUUID().slice(0, 8)}`;
      let idx = state.toolCallIdToIndex.get(toolCallId);
      if (idx === undefined) {
        idx = state.toolCallIndex++;
        state.toolCallIdToIndex.set(toolCallId, idx);
      }

      const toolName = (event.toolName as string) || (event.name as string) || 'tool';
      const input = event.input ?? event.arguments;
      const argsStr = typeof input === 'string' ? input : input ? JSON.stringify(input) : '';

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
                      name: toolName,
                      arguments: argsStr,
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
      // CLI source: finish event has rawFinishReason and finishReason
      // finishReason values: 'tool-calls' -> map to 'tool_calls', 'length' -> 'length', else 'stop'
      state.sawFinish = true;
      const rawFR = event.finishReason || (state.toolCallIdToIndex.size > 0 ? 'tool-calls' : 'stop');
      const finishReason = rawFR === 'tool-calls' || rawFR === 'tool_calls' ? 'tool_calls'
        : rawFR === 'length' || rawFR === 'max_tokens' ? 'length'
        : 'stop';
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
