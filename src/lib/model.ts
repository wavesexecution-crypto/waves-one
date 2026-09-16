export type Status = 'planning' | 'queued' | 'running' | 'blocked' | 'review' | 'completed';
export type Goal = { id: string; title: string; description: string; status: 'planning' | 'active' | 'completed'; deadline: string; owner: string; project: string };
export type Task = { id: string; title: string; goalId: string; project: string; owner: string; status: Status; priority: 'High' | 'Medium' | 'Low'; deadline: string; dependencies: string[]; approvalRequired: boolean; output: string; activity: string[] };
export type Approval = { id: string; title: string; project: string; kind: 'deployment' | 'payment' | 'access'; status: 'pending' | 'approved' | 'rejected' | 'changes-requested' | 'completed'; what: string; why: string; impact: string; risk: string; cost: string; evidence: string[]; requestedBy: string; createdAt: string; goalId: string; note?: string };
export type Worker = { id: string; name: string; initials: string; role: string; department: string; type: 'Employee' | 'Contractor' | 'AI agent' | 'Automated worker'; status: 'active' | 'blocked' | 'idle'; taskId?: string; projects: string[]; completed: number; permissions: string[] };
export type Incident = { id: string; title: string; project: string; impact: string; status: 'investigating' | 'resolved'; severity: 'error' | 'warning'; detected: string; agent: string; timeline: string[] };
export type Artifact = { id: string; name: string; kind: string; project: string; goalId: string; createdBy: string; createdAt: string; size: string; content: string };
export type Connector = { id: string; name: string; description: string; status: 'simulated' | 'not-connected'; capabilities: string[] };
export type Permission = { id: string; label: string; description: string; risk: 'low' | 'high'; value: 'allowed' | 'approval' | 'denied' };
export type Activity = { id: string; actor: string; timestamp: string; target: string; action: string; result: string; approvalState: string; category: 'Person' | 'Agent' | 'System' | 'Goal'; severity: 'info' | 'warning' | 'error' | 'success'; goalId?: string; project?: string };
export type State = { version: 1; goals: Goal[]; tasks: Task[]; approvals: Approval[]; workers: Worker[]; incidents: Incident[]; files: Artifact[]; connectors: Connector[]; permissions: Permission[]; activity: Activity[]; agentPaused: boolean; agentRuns: number };
export type Plan = { goal: Goal; tasks: Task[] };
export type Action =
  | { type: 'DECIDE'; id: string; decision: 'approved' | 'rejected' | 'changes-requested'; note: string }
  | { type: 'EXECUTE_APPROVED'; id: string }
  | { type: 'ADD_GOAL'; plan: Plan }
  | { type: 'DELEGATE' | 'COMPLETE_TASK' | 'RESOLVE_INCIDENT'; id: string }
  | { type: 'UNBLOCK'; id: string; note: string }
  | { type: 'PERMISSION'; id: string; value: Permission['value'] }
  | { type: 'AGENT_TOGGLE' | 'AGENT_RUN' | 'RESET' };

const seedTime = '2026-09-17T09:00:00+05:30';
const goals: Goal[] = [
  { id: 'g1', title: 'SEAI App Store submission', description: 'Make the Shopify installation journey reliable and prepare every asset required for App Store review.', status: 'active', deadline: '22 Sep', owner: 'WAVES AI', project: 'SEAI Gateway' },
  { id: 'g2', title: 'Waves website launch', description: 'Launch a fast, accessible website that makes our work and services clear.', status: 'active', deadline: '25 Sep', owner: 'Product / UI', project: 'Waves website' },
  { id: 'g3', title: 'Infrastructure reliability', description: 'Remove capacity risks and establish verified recovery procedures before the next growth phase.', status: 'active', deadline: '20 Sep', owner: 'Infrastructure', project: 'Infrastructure' },
  { id: 'g4', title: 'Q4 growth foundation', description: 'Prepare focused positioning, qualified accounts, and a reviewable acquisition plan.', status: 'active', deadline: '30 Sep', owner: 'Growth', project: 'Waves growth' },
];
function seedTask(id: string, title: string, goalId: string, owner: string, status: Status, dependencies: string[] = [], approvalRequired = false): Task {
  const goal = goals.find(g => g.id === goalId)!;
  return { id, title, goalId, project: goal.project, owner, status, priority: goalId === 'g1' ? 'High' : 'Medium', deadline: goal.deadline, dependencies, approvalRequired, output: status === 'completed' ? 'Simulated output verified against the acceptance checklist. Evidence retained with the connected goal.' : '', activity: [status === 'completed' ? 'Output reviewed and verified in the demo.' : status === 'blocked' ? 'Waiting for authorized sandbox API access. No credentials are stored in this demo.' : 'Assigned by WAVES AI. Linked to goal and acceptance criteria.'] };
}
const tasks: Task[] = [
  seedTask('t1', 'Validate OAuth redirect handling', 'g1', 'Developer 01', 'running'),
  seedTask('t2', 'Fix checkout webhook retries', 'g1', 'Developer 02', 'running'),
  seedTask('t3', 'Connect sandbox API credentials', 'g1', 'Developer 04', 'blocked'),
  seedTask('t4', 'Verify release readiness', 'g1', 'Developer 03', 'queued', ['t3'], true),
  seedTask('t5', 'Build product analytics', 'g1', 'Developer 05', 'running'),
  seedTask('t6', 'Review OAuth pull request', 'g1', 'Developer 06', 'running'),
  seedTask('t7', 'Validate required Shopify scopes', 'g1', 'Developer 03', 'completed'),
  seedTask('t8', 'Run 37 OAuth regression tests', 'g1', 'Developer 03', 'completed'),
  seedTask('t9', 'Prepare store submission checklist', 'g1', 'WAVES AI', 'completed'),
  seedTask('t10', 'Design the case study experience', 'g2', 'Product / UI', 'running'),
  seedTask('t11', 'Approve website content structure', 'g2', 'Amey', 'completed'),
  seedTask('t12', 'Verify mobile accessibility', 'g2', 'Product / UI', 'queued', ['t10']),
  seedTask('t13', 'Prepare capacity upgrade', 'g3', 'Infrastructure', 'review', [], true),
  seedTask('t14', 'Verify backup restoration', 'g3', 'Backup worker', 'completed'),
  seedTask('t15', 'Build qualified account shortlist', 'g4', 'Growth', 'running'),
  seedTask('t16', 'Define ideal customer profile', 'g4', 'Growth', 'completed'),
];
const approvals: Approval[] = [
  { id: 'a1', title: 'Production deployment ready', project: 'SEAI Gateway', kind: 'deployment', status: 'pending', what: 'Deploy the reviewed OAuth callback patch to the SEAI production environment.', why: 'Restore the Shopify installation flow and unblock submission readiness.', impact: '14 reviewed files change. Existing merchant data is not modified. Rollback remains available.', risk: 'OAuth callbacks may regress. Canary checks and rollback verification are required before rollout.', cost: 'No additional cost', evidence: ['14 files changed', '37 tests passed', '0 critical errors', 'Demo release candidate: seai-rc.24', 'Rollback checklist: previous stable revision retained'], requestedBy: 'WAVES AI', createdAt: seedTime, goalId: 'g1' },
  { id: 'a2', title: 'Infrastructure upgrade', project: 'Infrastructure', kind: 'payment', status: 'pending', what: 'Increase storage and compute capacity for the next growth phase.', why: 'Current storage utilization is approaching the operational threshold.', impact: 'Additional capacity and a higher monthly operating cost. No deletion of existing data.', risk: 'Recurring spend and migration downtime. Review capacity assumptions before authorizing.', cost: '₹48,000/month', evidence: ['Storage utilization: 84% in sample telemetry', 'Capacity plan: 90 days of headroom', 'Monthly cost comparison prepared'], requestedBy: 'Infrastructure', createdAt: seedTime, goalId: 'g3' },
  { id: 'a3', title: 'Sandbox access request', project: 'SEAI Gateway', kind: 'access', status: 'pending', what: 'Authorize scoped sandbox access for the engineering test workspace.', why: 'Developer 04 cannot validate the installation flow without sandbox access.', impact: 'Test-workspace access only. Production secrets remain unavailable.', risk: 'Sensitive credentials must be issued through a credential manager, never this interface.', cost: 'No additional cost', evidence: ['Requested scope: sandbox API', 'Production access: excluded', 'Owner: Developer 04'], requestedBy: 'Developer 04', createdAt: seedTime, goalId: 'g1' },
];
const workers: Worker[] = [
  { id: 'w0', name: 'Amey', initials: 'AM', role: 'Founder', department: 'Executive', type: 'Employee', status: 'active', projects: ['SEAI Gateway', 'Waves website'], completed: 24, permissions: ['Review decisions', 'Set direction'] },
  ...Array.from({ length: 6 }, (_, i): Worker => { const name = `Developer 0${i + 1}`; const task = tasks.find(t => t.owner === name && t.status !== 'completed'); return { id: `w${i + 1}`, name, initials: `D${i + 1}`, role: 'Software engineer', department: 'Engineering', type: 'Employee', status: task?.status === 'blocked' ? 'blocked' : 'active', taskId: task?.id, projects: ['SEAI Gateway'], completed: 12 + i * 3, permissions: ['Read repository', 'Write sandbox files', 'Request deployment'] }; }),
  { id: 'w7', name: 'Product / UI', initials: 'UI', role: 'Product designer', department: 'Design', type: 'Contractor', status: 'active', taskId: 't10', projects: ['Waves website'], completed: 19, permissions: ['Design workspace', 'Create artifacts'] },
  { id: 'w8', name: 'Growth', initials: 'GR', role: 'Acquisition specialist', department: 'Growth', type: 'Employee', status: 'active', taskId: 't15', projects: ['Waves growth'], completed: 11, permissions: ['Read account research', 'Draft messages'] },
  { id: 'w9', name: 'Infrastructure', initials: 'IN', role: 'Infrastructure operator', department: 'Operations', type: 'Employee', status: 'active', taskId: 't13', projects: ['Infrastructure'], completed: 26, permissions: ['Read telemetry', 'Request capacity changes'] },
  { id: 'w10', name: 'WAVES AI', initials: 'AI', role: 'Planning and verification', department: 'Operations', type: 'AI agent', status: 'active', projects: ['SEAI Gateway', 'Waves website', 'Infrastructure'], completed: 42, permissions: ['Plan work', 'Inspect demo workspace', 'Escalate decisions'] },
  { id: 'w11', name: 'Backup worker', initials: 'BW', role: 'Backup verifier', department: 'Operations', type: 'Automated worker', status: 'idle', taskId: 't14', projects: ['Infrastructure'], completed: 90, permissions: ['Read backup reports'] },
];
const permissions: Permission[] = [
  { id: 'read', label: 'Read files', description: 'Inspect files inside the authorized demo workspace.', risk: 'low', value: 'allowed' },
  { id: 'write', label: 'Write files', description: 'Create or modify sandbox artifacts.', risk: 'low', value: 'allowed' },
  { id: 'terminal', label: 'Run terminal commands', description: 'Only simulated allowlisted inspection and test commands.', risk: 'low', value: 'allowed' },
  { id: 'browser', label: 'Access browser', description: 'Read-only browsing in the simulated workspace.', risk: 'low', value: 'allowed' },
  { id: 'github', label: 'Access GitHub', description: 'Read project metadata; external writes need a decision.', risk: 'low', value: 'allowed' },
  { id: 'google', label: 'Access Google', description: 'Document access requires explicit approval.', risk: 'high', value: 'approval' },
  { id: 'delete', label: 'Delete files', description: 'Destructive operations always come back to you.', risk: 'high', value: 'approval' },
  { id: 'deploy', label: 'Deploy', description: 'Release changes only after a reviewed deployment decision.', risk: 'high', value: 'approval' },
  { id: 'spend', label: 'Spend money', description: 'Review every payment and recurring commitment.', risk: 'high', value: 'approval' },
  { id: 'messages', label: 'Send external messages', description: 'Review audience and content before sending.', risk: 'high', value: 'approval' },
  { id: 'production', label: 'Modify production', description: 'Production mutations require a dedicated release decision.', risk: 'high', value: 'approval' },
  { id: 'credentials', label: 'Access credentials', description: 'No real credentials are stored or accessible in this prototype.', risk: 'high', value: 'denied' },
];
const files: Artifact[] = [
  { id: 'f1', name: 'seai-release-verification.md', kind: 'Verification report', project: 'SEAI Gateway', goalId: 'g1', createdBy: 'WAVES AI', createdAt: seedTime, size: '1.2 KB', content: '# SEAI release verification\n\nSIMULATED EVIDENCE — not a production test run.\n\nScope: OAuth callback handling and Shopify installation.\nFiles changed: 14\nRegression tests: 37 passed\nCritical errors in candidate: 0\n\nProduction incident remains under investigation until an authorized recovery is verified.\n\nRelease gates:\n- Owner deployment approval\n- Sandbox access verification\n- Canary installation check\n- Rollback check\n\nProvenance: WAVES AI / SEAI App Store submission / local demo.' },
  { id: 'f2', name: 'shopify-submission-checklist.md', kind: 'Checklist', project: 'SEAI Gateway', goalId: 'g1', createdBy: 'WAVES AI', createdAt: seedTime, size: '0.8 KB', content: '# App Store submission\n\n[x] Validate required scopes\n[x] Run regression test fixture\n[ ] Verify callback patch after approval\n[ ] Prepare store assets\n[ ] Review screenshots\n[ ] Complete privacy and support documentation\n[ ] Owner submission decision\n\nThis checklist is sample data and does not imply Shopify approval.' },
  { id: 'f3', name: 'website-launch-brief.md', kind: 'Design brief', project: 'Waves website', goalId: 'g2', createdBy: 'Product / UI', createdAt: seedTime, size: '0.6 KB', content: '# Waves website launch\n\nOutcome: explain our work clearly and make the next step obvious.\n\nAcceptance criteria:\n- Mobile-first case studies\n- Keyboard accessible navigation\n- Clear contact path\n- Reviewed content and asset provenance\n- Verified launch candidate before deployment\n\nOwner: Product / UI. This is a local demo artifact.' },
  { id: 'f4', name: 'capacity-upgrade-plan.md', kind: 'Capacity plan', project: 'Infrastructure', goalId: 'g3', createdBy: 'Infrastructure', createdAt: seedTime, size: '0.7 KB', content: '# Infrastructure capacity proposal\n\nSample storage use: 84%.\nProposed cost: INR 48,000/month.\nTarget: 90 days of operating headroom.\n\nRisks: recurring cost and migration downtime.\nMitigations: scheduled migration, verified backup, rollback rehearsal.\n\nNo purchase has been made. Owner approval is required.' },
];
export const initialState: State = {
  version: 1, goals, tasks, approvals, workers, permissions, files, agentPaused: false, agentRuns: 0,
  incidents: [
    { id: 'i1', title: 'OAuth callback failing', project: 'SEAI Gateway', impact: 'Shopify installation flow affected.', status: 'investigating', severity: 'error', detected: '02:14', agent: 'WAVES AI', timeline: ['02:14 — Callback failure detected in sample telemetry.', '02:18 — Redirect mismatch isolated in demo logs.', '02:24 — Candidate patch prepared by Developer 01.', '02:31 — Regression evidence prepared. Owner review required.'] },
    { id: 'i2', title: 'Storage capacity approaching threshold', project: 'Infrastructure', impact: '84% utilization. Capacity review recommended.', status: 'investigating', severity: 'warning', detected: '08:42', agent: 'Infrastructure', timeline: ['08:42 — Sample utilization crossed the warning threshold.', '08:47 — Upgrade proposal prepared.', '08:51 — Monthly cost escalated for owner approval.'] },
  ],
  connectors: [
    ['github', 'GitHub', 'Repository, pull request, and release context.', ['Repositories', 'Pull requests', 'Checks']],
    ['google', 'Google Workspace', 'Documents, calendars, and authorized company files.', ['Documents', 'Drive', 'Calendar']],
    ['browser', 'Browser', 'Supervised browsing and evidence capture.', ['Read pages', 'Capture evidence']],
    ['workstation', 'Local workstation', 'Bounded workspace file access. No actual directories are connected.', ['Files', 'VS Code', 'Git']],
    ['terminal', 'Terminal', 'Allowlisted commands in a future isolated execution environment.', ['Inspect', 'Test', 'Verify']],
    ['vercel', 'Vercel', 'Preview deployments and approved production releases.', ['Preview', 'Deployment logs']],
    ['cloud', 'Cloud infrastructure', 'Capacity, monitoring, and change requests.', ['Telemetry', 'Capacity']],
    ['communication', 'Communication tools', 'Draft messages and approval-gated delivery.', ['Draft', 'Review', 'Send']],
    ['storage', 'File storage', 'Goal-linked documents and generated deliverables.', ['Files', 'Provenance']],
  ].map(([id, name, description, capabilities]) => ({ id, name, description, capabilities, status: 'not-connected' }) as Connector),
  activity: [
    { id: 'e1', actor: 'Developer 03', timestamp: '2026-09-17T02:31:00+05:30', target: 't8', action: 'Completed OAuth tests', result: '37 simulated regression tests passed.', approvalState: 'not-required', category: 'Person', severity: 'success', goalId: 'g1', project: 'SEAI Gateway' },
    { id: 'e2', actor: 'WAVES AI', timestamp: '2026-09-17T02:28:00+05:30', target: 'i1', action: 'Detected a deployment error', result: 'Incident escalated for review.', approvalState: 'pending', category: 'Agent', severity: 'error', goalId: 'g1', project: 'SEAI Gateway' },
    { id: 'e3', actor: 'Developer 01', timestamp: '2026-09-17T02:24:00+05:30', target: 't1', action: 'Prepared an OAuth fix', result: 'Candidate patch ready for verification.', approvalState: 'pending', category: 'Person', severity: 'info', goalId: 'g1', project: 'SEAI Gateway' },
    { id: 'e4', actor: 'WAVES AI', timestamp: '2026-09-17T02:21:00+05:30', target: 'a1', action: 'Prepared release candidate', result: 'Deployment held for owner approval.', approvalState: 'pending', category: 'Agent', severity: 'info', goalId: 'g1', project: 'SEAI Gateway' },
    { id: 'e5', actor: 'WAVES AI', timestamp: '2026-09-17T02:18:00+05:30', target: 'g1', action: 'Updated the execution plan', result: 'Dependencies and acceptance criteria recorded.', approvalState: 'not-required', category: 'Goal', severity: 'info', goalId: 'g1', project: 'SEAI Gateway' },
  ],
};

function id(prefix: string) { return `${prefix}-${globalThis.crypto.randomUUID()}`; }
function record(state: State, event: Omit<Activity, 'id' | 'timestamp'>): State {
  return { ...state, activity: [{ ...event, id: id('event'), timestamp: new Date().toISOString() }, ...state.activity] };
}
function ownerEvent(state: State, target: string, action: string, result: string, approvalState = 'not-required', goalId?: string): State {
  const goal = state.goals.find(g => g.id === goalId);
  return record(state, { actor: 'Amey', target, action, result, approvalState, category: 'Person', severity: approvalState === 'rejected' ? 'warning' : 'success', goalId, project: goal?.project });
}
export function goalProgress(goalId: string, state: State): number {
  const tasks = state.tasks.filter(t => t.goalId === goalId);
  return tasks.length ? Math.round(tasks.filter(t => t.status === 'completed').length / tasks.length * 100) : 0;
}
function eligibleApproval(task: Task, state: State): boolean {
  if (!task.approvalRequired) return true;
  const kind: Approval['kind'] = task.id === 't13' ? 'payment' : 'deployment';
  return state.approvals.some(a => a.goalId === task.goalId && a.kind === kind && a.status === 'completed');
}
export function canComplete(task: Task, state: State): boolean {
  return ['running', 'review', 'queued'].includes(task.status)
    && state.goals.some(g => g.id === task.goalId && g.status === 'active')
    && task.dependencies.every(dependency => state.tasks.some(t => t.id === dependency && t.status === 'completed'))
    && eligibleApproval(task, state);
}
function reconcile(state: State): State {
  const tasks = state.tasks.map(task => task.status === 'queued' && task.dependencies.every(dependency => state.tasks.some(t => t.id === dependency && t.status === 'completed')) && state.goals.some(g => g.id === task.goalId && g.status === 'active') ? { ...task, status: task.approvalRequired ? 'review' as const : 'running' as const } : task);
  const goals = state.goals.map(goal => goal.status === 'active' && tasks.some(t => t.goalId === goal.id) && tasks.filter(t => t.goalId === goal.id).every(t => t.status === 'completed') ? { ...goal, status: 'completed' as const } : goal);
  const workers = state.workers.map(worker => { const active = tasks.find(t => t.owner === worker.name && !['completed', 'planning'].includes(t.status)); return { ...worker, taskId: active?.id, status: active ? active.status === 'blocked' ? 'blocked' as const : 'active' as const : 'idle' as const }; });
  return { ...state, tasks, goals, workers };
}
export function planGoal(text: string): Plan {
  const input = text.trim();
  if (!input || input.length > 500) throw new Error('Enter a goal between 1 and 500 characters.');
  const goalId = id('goal');
  const isStore = /shopify|seai|app store/i.test(input);
  const isSite = /website|site|launch/i.test(input);
  const goal: Goal = { id: goalId, title: input, description: `Outcome: ${input}. Review the suggested scope before delegation. This plan is a deterministic local template.`, status: 'planning', deadline: '30 Sep', owner: 'WAVES AI', project: isStore ? 'SEAI Gateway' : isSite ? 'Waves website' : 'Waves operations' };
  const titles = isStore ? ['Validate OAuth and required scopes', 'Run installation and production test fixtures', 'Prepare store assets and screenshots', 'Complete submission documentation', 'Verify and release submission package'] : isSite ? ['Review launch scope and content', 'Build and review the launch candidate', 'Verify mobile accessibility and performance', 'Prepare launch checklist and handover', 'Approve and verify website release'] : ['Clarify scope and acceptance criteria', 'Prepare implementation and supporting evidence', 'Verify outputs against the goal', 'Document handover and operational checklist', 'Approve final delivery'];
  const ids = titles.map(() => id('task'));
  const owners = ['WAVES AI', 'Developer 01', isStore ? 'Product / UI' : 'Developer 03', 'Infrastructure', 'WAVES AI'];
  return { goal, tasks: titles.map((title, i) => ({ id: ids[i], title, goalId, project: goal.project, owner: owners[i], status: 'planning', priority: i === 4 ? 'High' : 'Medium', deadline: goal.deadline, dependencies: i ? [ids[i - 1]] : [], approvalRequired: i === 4, output: '', activity: ['Proposed by a local planning template. Awaiting delegation.'] })) };
}
function finalApproval(state: State, task: Task): State {
  if (state.approvals.some(a => a.goalId === task.goalId && a.kind === 'deployment' && ['pending', 'approved', 'completed'].includes(a.status))) return state;
  const approval: Approval = { id: id('approval'), title: `Release review: ${state.goals.find(g => g.id === task.goalId)?.title}`, goalId: task.goalId, project: task.project, kind: 'deployment', status: 'pending', what: `Deliver verified output for ${task.title}.`, why: 'All prerequisite work is verified. The final release needs human judgment.', impact: 'Marks this local delivery as authorized. No external system changes.', risk: 'Verify the output and scope before authorizing. Simulation evidence does not validate a real release.', cost: 'No simulated additional cost', evidence: task.dependencies.map(dep => `${state.tasks.find(t => t.id === dep)?.title}: verified in simulation`), requestedBy: 'WAVES AI', createdAt: new Date().toISOString() };
  return record({ ...state, approvals: [approval, ...state.approvals] }, { actor: 'WAVES AI', target: approval.id, action: 'Escalated final release for approval', result: 'Simulated execution held pending owner decision.', approvalState: 'pending', category: 'Agent', severity: 'warning', goalId: task.goalId, project: task.project });
}
export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'RESET': return structuredClone(initialState);
    case 'DECIDE': {
      const approval = state.approvals.find(a => a.id === action.id);
      if (!approval || approval.status !== 'pending' || !['approved', 'rejected', 'changes-requested'].includes(action.decision) || (action.decision !== 'approved' && !action.note.trim())) return state;
      const next = { ...state, approvals: state.approvals.map(a => a.id === action.id ? { ...a, status: action.decision, note: action.note.trim().slice(0, 1000) } : a) };
      return ownerEvent(next, approval.id, `${action.decision} ${approval.title}`, `Decision recorded; simulated execution ${action.decision === 'approved' ? 'awaits a separate action' : 'is held'}.`, action.decision, approval.goalId);
    }
    case 'EXECUTE_APPROVED': {
      const approval = state.approvals.find(a => a.id === action.id);
      if (!approval || approval.status !== 'approved') return state;
      const permissionId = approval.kind === 'deployment' ? 'deploy' : approval.kind === 'payment' ? 'spend' : 'credentials';
      // Sandbox access approval never grants real credential access; the request itself remains the scoped authorization.
      if (approval.kind !== 'access' && state.permissions.find(p => p.id === permissionId)?.value === 'denied') return state;
      if (approval.kind === 'deployment' && state.permissions.find(p => p.id === 'production')?.value === 'denied') return state;
      const next = { ...state, approvals: state.approvals.map(a => a.id === action.id ? { ...a, status: 'completed' as const } : a) };
      return ownerEvent(reconcile(next), approval.id, `Verified simulated execution: ${approval.title}`, 'Approved action completed and verified in simulation. No external system changed.', 'approved', approval.goalId);
    }
    case 'ADD_GOAL': {
      if (state.goals.some(g => g.id === action.plan.goal.id) || !action.plan.goal.title.trim() || !action.plan.tasks.length || action.plan.tasks.some(t => t.goalId !== action.plan.goal.id)) return state;
      return ownerEvent({ ...state, goals: [action.plan.goal, ...state.goals], tasks: [...action.plan.tasks, ...state.tasks] }, action.plan.goal.id, 'Created a goal and reviewable plan', 'Template plan saved; simulated work has not started.', 'not-required', action.plan.goal.id);
    }
    case 'DELEGATE': {
      const goal = state.goals.find(g => g.id === action.id);
      if (!goal || goal.status !== 'planning') return state;
      const next = reconcile({ ...state, goals: state.goals.map(g => g.id === action.id ? { ...g, status: 'active' as const } : g), tasks: state.tasks.map(t => t.goalId === action.id ? { ...t, status: 'queued' as const, activity: [...t.activity, 'Delegated to a simulated worker.'] } : t) });
      return ownerEvent(next, goal.id, 'Delegated execution plan', 'Eligible simulated workers started; dependent work remains queued.', 'not-required', goal.id);
    }
    case 'COMPLETE_TASK': {
      const task = state.tasks.find(t => t.id === action.id);
      if (!task || !canComplete(task, state)) return state;
      let next = reconcile({ ...state, tasks: state.tasks.map(t => t.id === action.id ? { ...t, status: 'completed' as const, output: `Simulated verification passed for: ${t.title}. Acceptance checklist reviewed; no external work was performed.`, activity: [...t.activity, 'Amey requested simulated verification. Output verified and task completed.'] } : t), workers: state.workers.map(w => w.name === task.owner ? { ...w, completed: w.completed + 1 } : w) });
      next = ownerEvent(next, task.id, `Verified and completed ${task.title}`, 'Output verified in simulation. Dependencies updated.', 'not-required', task.goalId);
      for (const candidate of next.tasks.filter(t => t.goalId === task.goalId && t.status === 'review' && t.approvalRequired)) next = finalApproval(next, candidate);
      return next;
    }
    case 'UNBLOCK': {
      const task = state.tasks.find(t => t.id === action.id);
      if (!task || task.status !== 'blocked' || !action.note.trim()) return state;
      return ownerEvent(reconcile({ ...state, tasks: state.tasks.map(t => t.id === action.id ? { ...t, status: 'running' as const, activity: [...t.activity, `Amey resolved blocker: ${action.note.trim().slice(0, 1000)}`] } : t) }), task.id, `Resolved blocker: ${task.title}`, 'Human intervention recorded. Simulated work resumed.', 'not-required', task.goalId);
    }
    case 'RESOLVE_INCIDENT': {
      const incident = state.incidents.find(i => i.id === action.id);
      if (!incident || incident.status === 'resolved') return state;
      return ownerEvent({ ...state, incidents: state.incidents.map(i => i.id === action.id ? { ...i, status: 'resolved' as const, timeline: [...i.timeline, 'Amey simulated recovery and verified the local result. No production system changed.'] } : i) }, incident.id, 'Verified simulated incident recovery', 'Simulated health checks passed. No real remediation occurred.', 'not-required');
    }
    case 'PERMISSION': {
      const permission = state.permissions.find(p => p.id === action.id);
      if (!permission || !['allowed', 'approval', 'denied'].includes(action.value) || (permission.risk === 'high' && action.value === 'allowed') || permission.value === action.value) return state;
      return ownerEvent({ ...state, permissions: state.permissions.map(p => p.id === action.id ? { ...p, value: action.value } : p) }, permission.id, `Changed ${permission.label} permission`, `Local simulation permission set to ${action.value}. Real permissions are unaffected.`, action.value);
    }
    case 'AGENT_TOGGLE': return ownerEvent({ ...state, agentPaused: !state.agentPaused }, 'computer-agent', state.agentPaused ? 'Resumed computer agent' : 'Paused computer agent', 'New simulated inspection jobs are ' + (state.agentPaused ? 'enabled.' : 'paused.'));
    case 'AGENT_RUN': {
      if (state.agentPaused || !['read', 'terminal'].every(key => state.permissions.find(p => p.id === key)?.value === 'allowed')) return state;
      const run = state.agentRuns + 1;
      const file: Artifact = { id: id('file'), name: `inspection-${run}.md`, kind: 'Agent verification', project: 'SEAI Gateway', goalId: 'g1', createdBy: 'WAVES AI', createdAt: new Date().toISOString(), size: '0.4 KB', content: `# Simulated inspection ${run}\n\nAuthorized demo workspace inspected.\n37 fixture tests passed.\nNo real commands ran and no real files were accessed.\nA production release still needs an explicit owner decision.` };
      let next: State = { ...state, agentRuns: run, files: [file, ...state.files] };
      for (const [action, result] of [['Inspected authorized workspace', 'Read demo repository metadata.'], ['Ran simulated regression checks', '37 fixture tests passed. No commands ran.'], ['Verified simulated inspection output', `Artifact ${file.name} retained with provenance.`]]) next = record(next, { actor: 'WAVES AI', target: file.id, action, result, approvalState: 'not-required', category: 'Agent', severity: 'success', goalId: 'g1', project: 'SEAI Gateway' });
      if (!next.approvals.some(a => a.goalId === 'g1' && a.kind === 'deployment' && ['pending', 'approved'].includes(a.status))) next = finalApproval(next, { ...tasks[3], goalId: 'g1' });
      return next;
    }
    default: return state;
  }
}

// Validate persisted demo records before any UI uses nested fields. localStorage is not trusted authentication.
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string'); }
function fields(value: unknown, keys: string[]): value is RecordValue { return object(value) && keys.every(key => typeof value[key] === 'string'); }
function oneOf(value: unknown, values: readonly string[]) { return typeof value === 'string' && values.includes(value); }
function finite(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function validState(value: unknown): value is State {
  if (!object(value) || value.version !== 1 || typeof value.agentPaused !== 'boolean' || !finite(value.agentRuns)) return false;
  const validArrays = ['goals', 'tasks', 'approvals', 'workers', 'incidents', 'files', 'connectors', 'permissions', 'activity'];
  if (!validArrays.every(key => Array.isArray(value[key]))) return false;
  const arrays = value as Record<string, unknown[]>;
  if (!arrays.goals.every(g => fields(g, ['id', 'title', 'description', 'deadline', 'owner', 'project']) && oneOf(g.status, ['planning', 'active', 'completed']))) return false;
  if (!arrays.tasks.every(t => fields(t, ['id', 'title', 'goalId', 'project', 'owner', 'deadline', 'output']) && oneOf(t.status, ['planning', 'queued', 'running', 'blocked', 'review', 'completed']) && oneOf(t.priority, ['High', 'Medium', 'Low']) && strings(t.dependencies) && strings(t.activity) && typeof t.approvalRequired === 'boolean')) return false;
  if (!arrays.approvals.every(a => fields(a, ['id', 'title', 'project', 'what', 'why', 'impact', 'risk', 'cost', 'requestedBy', 'createdAt', 'goalId']) && oneOf(a.kind, ['deployment', 'payment', 'access']) && oneOf(a.status, ['pending', 'approved', 'rejected', 'changes-requested', 'completed']) && strings(a.evidence) && (a.note === undefined || typeof a.note === 'string'))) return false;
  if (!arrays.workers.every(w => fields(w, ['id', 'name', 'initials', 'role', 'department']) && oneOf(w.type, ['Employee', 'Contractor', 'AI agent', 'Automated worker']) && oneOf(w.status, ['active', 'blocked', 'idle']) && strings(w.projects) && strings(w.permissions) && finite(w.completed) && (w.taskId === undefined || typeof w.taskId === 'string'))) return false;
  if (!arrays.incidents.every(i => fields(i, ['id', 'title', 'project', 'impact', 'detected', 'agent']) && oneOf(i.status, ['investigating', 'resolved']) && oneOf(i.severity, ['error', 'warning']) && strings(i.timeline))) return false;
  if (!arrays.files.every(f => fields(f, ['id', 'name', 'kind', 'project', 'goalId', 'createdBy', 'createdAt', 'size', 'content']))) return false;
  if (!arrays.connectors.every(c => fields(c, ['id', 'name', 'description']) && oneOf(c.status, ['simulated', 'not-connected']) && strings(c.capabilities))) return false;
  if (!arrays.permissions.every(p => fields(p, ['id', 'label', 'description']) && oneOf(p.risk, ['low', 'high']) && oneOf(p.value, ['allowed', 'approval', 'denied']) && !(p.risk === 'high' && p.value === 'allowed'))) return false;
  if (!arrays.activity.every(e => fields(e, ['id', 'actor', 'timestamp', 'target', 'action', 'result', 'approvalState']) && oneOf(e.category, ['Person', 'Agent', 'System', 'Goal']) && oneOf(e.severity, ['info', 'warning', 'error', 'success']) && (e.goalId === undefined || typeof e.goalId === 'string') && (e.project === undefined || typeof e.project === 'string'))) return false;
  if (!validArrays.every(key => new Set(arrays[key].map(v => (v as RecordValue).id)).size === arrays[key].length)) return false;
  const state = value as unknown as State;
  const goalIds = new Set(state.goals.map(g => g.id));
  const taskIds = new Set(state.tasks.map(t => t.id));
  return state.tasks.every(t => goalIds.has(t.goalId) && t.dependencies.every(d => taskIds.has(d) && d !== t.id)) && state.approvals.every(a => goalIds.has(a.goalId)) && state.files.every(f => goalIds.has(f.goalId));
}
export function parseSaved(raw: string | null): State | null {
  if (!raw) return null;
  try { const value: unknown = JSON.parse(raw); return validState(value) ? value : null; } catch { return null; }
}
