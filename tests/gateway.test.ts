import { describe, it, expect } from 'vitest';
import { CommandCodeAdapter, toWirePermissionMode } from '../src/adapters/commandcode/adapter.js';
import { resolveModelName } from '../src/utils/models.js';

describe('CommandCode Proxy v3 Test Suite', () => {
  const adapter = new CommandCodeAdapter();

  it('correctly maps toWirePermissionMode per official CLI wire protocol', () => {
    expect(toWirePermissionMode('bypass')).toBe('auto-accept');
    expect(toWirePermissionMode('auto-accept')).toBe('auto-accept');
    expect(toWirePermissionMode('plan')).toBe('plan');
    expect(toWirePermissionMode('standard')).toBe('standard');
    expect(toWirePermissionMode('anything')).toBe('standard');
  });

  it('resolves vendor-prefixed sub-agent model names cleanly', () => {
    expect(resolveModelName('anthropic:laguna-s-2.1-free')).toBe('poolside/laguna-s-2.1-free');
    expect(resolveModelName('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('translates OpenAI Chat request into official Command Code wire payload', () => {
    const req = adapter.translateOpenAIRequest({
      model: 'anthropic:laguna-s-2.1-free',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'high',
    });

    expect(req.permissionMode).toBe('auto-accept');
    expect(req.params.model).toBe('poolside/laguna-s-2.1-free');
    expect(req.config.workingDir).toBeDefined();
    expect(req.config.date).toBeDefined();
    expect(req.config.isGitRepo).toBe(true);
  });
});
