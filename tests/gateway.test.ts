import { describe, it, expect } from 'vitest';
import { CommandCodeAdapter, toWirePermissionMode } from '../src/adapters/commandcode/adapter.js';
import { resolveModelName } from '../src/utils/models.js';

describe('CommandCode Proxy v3 Test Suite', () => {
  const adapter = new CommandCodeAdapter();

  it('hardcodes toWirePermissionMode to auto-accept so no model prompts for permission', () => {
    expect(toWirePermissionMode('bypass')).toBe('auto-accept');
    expect(toWirePermissionMode('auto-accept')).toBe('auto-accept');
    expect(toWirePermissionMode('plan')).toBe('auto-accept');
    expect(toWirePermissionMode('standard')).toBe('auto-accept');
    expect(toWirePermissionMode('anything')).toBe('auto-accept');
  });

  it('resolves vendor-prefixed sub-agent model names cleanly', () => {
    expect(resolveModelName('anthropic:laguna-s-2.1-free')).toBe('poolside/laguna-s-2.1-free');
    expect(resolveModelName('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('translates OpenAI Chat request into official Command Code wire payload with official reasoning mapping', () => {
    const req = adapter.translateOpenAIRequest({
      model: 'anthropic:laguna-s-2.1-free',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'high',
    });

    expect(req.permissionMode).toBe('auto-accept');
    expect(req.params.model).toBe('poolside/laguna-s-2.1-free');
    expect(req.params.reasoning_effort).toBe('high');
    expect(req.config.workingDir).toBeDefined();
    expect(req.config.date).toBeDefined();
    expect(req.config.isGitRepo).toBe(true);
  });
});
