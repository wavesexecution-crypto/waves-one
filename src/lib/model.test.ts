import { describe, expect, it } from 'vitest';
import { initialState, reduce, parseSaved, planGoal, canComplete } from './model';

describe('CEO operating loop', () => {
  it('records an approval once without executing external work', () => {
    const next = reduce(initialState, { type: 'DECIDE', id: 'a1', decision: 'approved', note: 'Ready' });
    expect(next.approvals[0].status).toBe('approved');
    expect(next.activity[0].action).toContain('approved');
    expect(next.activity[0].result).toContain('simulated');
    expect(reduce(next, { type: 'DECIDE', id: 'a1', decision: 'rejected', note: '' })).toEqual(next);
  });
  it('rejection prevents approved execution', () => {
    const next = reduce(initialState, { type: 'DECIDE', id: 'a1', decision: 'rejected', note: 'Not ready' });
    expect(reduce(next, { type: 'EXECUTE_APPROVED', id: 'a1' })).toEqual(next);
  });
  it('approved execution is separately verified and audited', () => {
    const approved = reduce(initialState, { type: 'DECIDE', id: 'a1', decision: 'approved', note: '' });
    const completed = reduce(approved, { type: 'EXECUTE_APPROVED', id: 'a1' });
    expect(completed.approvals[0].status).toBe('completed');
    expect(completed.activity[0].action).toContain('Verified');
  });
  it('plans and delegates work connected to a goal', () => {
    const plan = planGoal('Get the Waves website ready for launch');
    expect(plan.tasks.length).toBeGreaterThanOrEqual(4);
    expect(plan.tasks.every(t => t.goalId === plan.goal.id)).toBe(true);
    const next = reduce(initialState, { type: 'ADD_GOAL', plan });
    expect(next.goals[0].status).toBe('planning');
    const delegated = reduce(next, { type: 'DELEGATE', id: plan.goal.id });
    expect(delegated.goals[0].status).toBe('active');
    expect(delegated.tasks.find(t => t.goalId === plan.goal.id)?.status).toBe('running');
  });
  it('rejects blank or excessive goal input', () => {
    expect(() => planGoal('  ')).toThrow();
    expect(() => planGoal('x'.repeat(501))).toThrow();
  });
  it('gates completion on dependencies and approvals', () => {
    const task = initialState.tasks.find(t => t.id === 't4')!;
    expect(canComplete(task, initialState)).toBe(false);
    expect(reduce(initialState, { type: 'COMPLETE_TASK', id: task.id })).toEqual(initialState);
  });
  it('resolves a blocker with human intervention and records actor', () => {
    const next = reduce(initialState, { type: 'UNBLOCK', id: 't3', note: 'Sandbox access assigned' });
    expect(next.tasks.find(t => t.id === 't3')?.status).toBe('running');
    expect(next.activity[0].actor).toBe('Amey');
  });
  it('holds high-risk permissions at approval or denied', () => {
    const next = reduce(initialState, { type: 'PERMISSION', id: 'deploy', value: 'allowed' });
    expect(next.permissions.find(p => p.id === 'deploy')?.value).toBe('approval');
  });
  it('supports agent pause and resume with an audit trail', () => {
    const next = reduce(initialState, { type: 'AGENT_TOGGLE' });
    expect(next.agentPaused).toBe(true);
    expect(next.activity[0].action).toContain('Paused');
  });
  it('does not run jobs while paused or denied', () => {
    const paused = reduce(initialState, { type: 'AGENT_TOGGLE' });
    expect(reduce(paused, { type: 'AGENT_RUN' })).toEqual(paused);
    const denied = reduce(initialState, { type: 'PERMISSION', id: 'read', value: 'denied' });
    expect(reduce(denied, { type: 'AGENT_RUN' })).toEqual(denied);
  });
  it('safely handles corrupt or wrong-shaped storage', () => {
    expect(parseSaved('{bad')).toBeNull();
    expect(parseSaved('{"version":1,"goals":[]}')).toBeNull();
    expect(parseSaved(JSON.stringify(initialState))).toEqual(initialState);
    expect(parseSaved(JSON.stringify({ ...initialState, tasks: [{ id: 'bad' }] }))).toBeNull();
  });
});
