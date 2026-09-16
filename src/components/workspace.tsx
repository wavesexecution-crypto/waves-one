"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Bot, Download, FileText, Layers, Pause, Play, Plus, Search, ShieldCheck, Terminal, Users, Waves } from "lucide-react";
import { useStore } from "./store";
import { Avatar, Badge, Empty, Modal, Progress, SectionTitle, StatusBadge, TextLink, dateLabel } from "./ui";
import type { Screen, ViewProps, Selection } from "./overview";
import type { Activity, Permission } from "../lib/model";

export function downloadFile(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Intro({ eyebrow, title, copy, children }: { eyebrow: string; title: string; copy: string; children?: ReactNode }) {
  return <div className="page-intro"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="intro-copy">{copy}</p></div>{children}</div>;
}

function Filters({ options, value, onChange, label }: { options: string[]; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="filter-bar" role="group" aria-label={label}>{options.map(option => <button key={option} className={`filter-chip ${value === option ? "active" : ""}`} aria-pressed={value === option} onClick={() => onChange(option)}>{option.replaceAll("-", " ")}</button>)}</div>;
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-field"><Search size={16} aria-hidden="true" /><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /></label>;
}

function SelectFilter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return <label className="detail-field"><span className="muted">{label}</span><select aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="all">All {label.toLowerCase()}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function Goals({ open, newGoal }: ViewProps) {
  const { state } = useStore();
  const [status, setStatus] = useState("All");
  const goals = state.goals.filter(goal => status === "All" || goal.status === status);
  return <>
    <Intro eyebrow="DIRECTION BEFORE EXECUTION" title="Goals" copy="The outcomes that move Waves forward."><button className="button primary" onClick={newGoal}><Plus size={16} />New goal</button></Intro>
    <Filters label="Goal status" options={["All", "planning", "active", "completed"]} value={status} onChange={setStatus} />
    <SectionTitle title="YOUR GOALS" count={goals.length} />
    <div className="card-grid">{goals.map(goal => {
      const tasks = state.tasks.filter(task => task.goalId === goal.id);
      const done = tasks.filter(task => task.status === "completed").length;
      const progress = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      return <button className="info-card goal-card" key={goal.id} onClick={() => open({ type: "goal", id: goal.id })}>
        <div className="goal-top"><span className="project-mark">{goal.project.slice(0, 2).toUpperCase()}</span><StatusBadge status={goal.status} /></div>
        <p className="eyebrow">{goal.project}</p><h3>{goal.title}</h3><p>{goal.description}</p>
        <p className="muted">{goal.owner} · Due {goal.deadline}</p>
        <div className="progress-label"><span>{done} / {tasks.length} tasks complete</span><span>{progress}%</span></div><Progress value={progress} />
      </button>;
    })}</div>
    {!goals.length && <Empty title="No goals in this view">Choose another status or create a goal to set the next direction.</Empty>}
  </>;
}

function Work({ open, newGoal }: ViewProps) {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const tasks = state.tasks.filter(task => {
    const goal = state.goals.find(item => item.id === task.goalId);
    return goal && (status === "All" || task.status === status) && `${task.title} ${task.owner} ${task.project} ${goal.title}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  return <>
    <Intro eyebrow="EVERY TASK HAS A PURPOSE" title="Work" copy="Follow execution from a goal to its final output."><button className="button" onClick={newGoal}><Plus size={16} />Plan from a goal</button></Intro>
    <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search work, owners, or goals" /><span className="muted">{tasks.length} linked tasks</span></div>
    <Filters label="Task status" options={["All", "planning", "queued", "running", "blocked", "review", "completed"]} value={status} onChange={setStatus} />
    <div className="table-wrap panel"><table className="data-table"><thead><tr><th scope="col">Task / goal</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Due</th></tr></thead><tbody>{tasks.map(task => {
      const goal = state.goals.find(item => item.id === task.goalId)!;
      return <tr key={task.id}><td><div className="row-main"><TextLink onClick={() => open({ type: "task", id: task.id })}>{task.title}</TextLink><TextLink onClick={() => open({ type: "goal", id: goal.id })}>{goal.title}</TextLink><small className="muted">{task.project}</small></div></td><td>{task.owner}</td><td><StatusBadge status={task.status} /></td><td>{task.priority}</td><td className="mono">{task.deadline}</td></tr>;
    })}</tbody></table>{!tasks.length && <Empty title="No matching work">Try another search or status. New work starts with a goal.</Empty>}</div>
  </>;
}

const departments = ["Executive", "Engineering", "Design", "Growth", "Client Success", "People", "Finance", "Operations"];
const departmentRoles: Record<string, string> = {
  Executive: "Executive leadership", Engineering: "Engineering lead", Design: "Design lead", Growth: "Growth lead", "Client Success": "Client success lead", People: "People lead", Finance: "Finance lead", Operations: "Operations lead",
};

function People({ open }: ViewProps) {
  const { state } = useStore();
  const [department, setDepartment] = useState("All");
  return <>
    <Intro eyebrow="ONE ORGANIZATION. DIFFERENT CAPABILITIES." title="People" copy="Your people, agents, and automated workers. Empty seats stay visible." />
    <div className="metric-strip"><div className="metric"><strong>{state.workers.filter(worker => ["Employee", "Contractor"].includes(worker.type)).length}</strong><span>People</span></div><div className="metric"><strong>{state.workers.filter(worker => ["AI agent", "Automated worker"].includes(worker.type)).length}</strong><span>Digital workers</span></div><div className="metric"><strong>{departments.length}</strong><span>Departments</span></div></div>
    <Filters label="Department" options={["All", ...departments]} value={department} onChange={setDepartment} />
    <div className="stack">{departments.filter(name => department === "All" || department === name).map(name => {
      const workers = state.workers.filter(worker => worker.department === name);
      return <section key={name}><SectionTitle title={name.toUpperCase()} count={workers.length} /><div className="card-grid">{workers.map(worker => <button className="info-card" key={worker.id} onClick={() => open({ type: "worker", id: worker.id })}>
        <div className="goal-top"><Avatar initials={worker.initials} agent={["AI agent", "Automated worker"].includes(worker.type)} /><ArrowUpRight size={16} /></div>
        <h3>{worker.name}</h3><p>{worker.role}</p><div className="toolbar"><Badge>{worker.type}</Badge><StatusBadge status={worker.status} /></div>
        <p className="muted">{state.tasks.find(task => task.id === worker.taskId)?.title || "No task assigned"}</p><small className="muted">{worker.projects.length ? worker.projects.join(" · ") : "No projects assigned"}</small>
      </button>)}{!workers.length && <article className="info-card"><Users size={20} className="muted" /><h3>{departmentRoles[name]}</h3><Badge>Unfilled</Badge><p className="muted">No one assigned to {name.toLowerCase()}. This is an organizational placeholder, not an active hire.</p></article>}</div></section>;
    })}</div>
  </>;
}

function Approvals({ open }: ViewProps) {
  const { state } = useStore();
  const [view, setView] = useState("Pending");
  const approvals = state.approvals.filter(approval => view === "Pending" ? approval.status === "pending" : approval.status !== "pending");
  return <>
    <Intro eyebrow="HUMAN JUDGMENT, AT THE RIGHT MOMENT" title="Approvals" copy="Review the evidence. Understand the impact. Make the call." />
    <Filters label="Approval view" options={["Pending", "History"]} value={view} onChange={setView} />
    <SectionTitle title={view === "Pending" ? "NEEDS YOUR DECISION" : "DECISION HISTORY"} count={approvals.length} />
    <div className="list-panel">{approvals.map(approval => <button className="list-row" key={approval.id} onClick={() => open({ type: "approval", id: approval.id })}><ShieldCheck size={20} /><div className="row-main"><span className="eyebrow">{approval.project} / {approval.kind}</span><strong>{approval.title}</strong><span className="muted">{approval.what}</span><small className="muted">Requested by {approval.requestedBy} · {dateLabel(approval.createdAt)}</small></div><StatusBadge status={approval.status} /><ArrowUpRight size={16} /></button>)}{!approvals.length && <Empty title={view === "Pending" ? "Nothing waiting on you" : "No decisions yet"}>{view === "Pending" ? "New requests will appear here when your judgment is needed." : "Approved, rejected, and returned requests will appear here."}</Empty>}</div>
  </>;
}

function ActivityView({ open }: ViewProps) {
  const { state, notify } = useStore();
  const [category, setCategory] = useState("All");
  const [severity, setSeverity] = useState("all");
  const [actor, setActor] = useState("all");
  const [project, setProject] = useState("all");
  const [goal, setGoal] = useState("all");
  const [audit, setAudit] = useState(false);
  const events = state.activity.filter(event => (category === "All" || event.category === category) && (severity === "all" || event.severity === severity) && (actor === "all" || event.actor === actor) && (project === "all" || event.project === project) && (goal === "all" || event.goalId === goal)).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const options = (values: string[]) => [...new Set(values)].sort().map(value => ({ value, label: value }));
  function selectionFor(event: Activity): Selection | undefined {
    const task = state.tasks.find(item => item.id === event.target || item.title === event.target);
    if (task) return { type: "task", id: task.id };
    const approval = state.approvals.find(item => item.id === event.target || item.title === event.target);
    if (approval) return { type: "approval", id: approval.id };
    const incident = state.incidents.find(item => item.id === event.target || item.title === event.target);
    if (incident) return { type: "incident", id: incident.id };
    const artifact = state.files.find(item => item.id === event.target || item.name === event.target);
    if (artifact) return { type: "file", id: artifact.id };
    const targetGoal = state.goals.find(item => item.id === event.target || item.title === event.target || item.id === event.goalId);
    if (targetGoal) return { type: "goal", id: targetGoal.id };
  }
  function exportAudit() {
    try { downloadFile("waves-audit.json", JSON.stringify({ exportedAt: new Date().toISOString(), scope: "Current filters", filters: { category, severity, actor, project, goal }, events }, null, 2)); notify("Filtered audit exported as JSON."); }
    catch { notify("Audit download failed. Please try again."); }
  }
  return <>
    <Intro eyebrow="NOTHING HAPPENS IN A BLACK BOX" title="Activity" copy="A traceable record of the decisions and actions in this demo." />
    <div className="toolbar"><button className="button" onClick={exportAudit}><Download size={16} />Export audit</button></div>
    <div className="toolbar"><Filters label="Activity category" options={["All", "Person", "Agent", "System", "Goal"]} value={category} onChange={setCategory} /><button className={`filter-chip ${audit ? "active" : ""}`} aria-pressed={audit} onClick={() => setAudit(!audit)}>Audit table</button></div>
    <div className="filter-bar"><SelectFilter label="Severities" value={severity} onChange={setSeverity} options={options(["info", "success", "warning", "error"])} /><SelectFilter label="Actors" value={actor} onChange={setActor} options={options(state.activity.map(event => event.actor))} /><SelectFilter label="Projects" value={project} onChange={setProject} options={options(state.activity.flatMap(event => event.project ? [event.project] : []))} /><SelectFilter label="Goals" value={goal} onChange={setGoal} options={state.goals.map(item => ({ value: item.id, label: item.title }))} /></div>
    <SectionTitle title="AUDIT TRAIL" count={events.length}><span className="muted">Newest first</span></SectionTitle>
    {audit ? <div className="table-wrap panel"><table className="data-table"><thead><tr>{["Actor", "Timestamp", "Target", "Action", "Result", "Approval state"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{events.map(event => <tr key={event.id}><td>{event.actor}<br /><small className="muted">{event.category}</small></td><td><time dateTime={event.timestamp} className="mono">{event.timestamp}</time></td><td>{event.target}</td><td>{event.action}</td><td>{event.result}</td><td>{event.approvalState}</td></tr>)}</tbody></table></div> : <div className="list-panel">{events.map(event => {
      const selection = selectionFor(event);
      return <article className="list-row" key={event.id}><Badge tone={event.severity}>{event.category}</Badge><div className="row-main"><strong>{event.actor} · {event.action}</strong><span>{event.result}</span><small className="muted">{event.project || event.target} · Approval: {event.approvalState}</small>{selection && <TextLink onClick={() => open(selection)}>View {selection.type}</TextLink>}</div><time dateTime={event.timestamp} title={event.timestamp} className="mono muted">{dateLabel(event.timestamp)}</time></article>;
    })}</div>}
    {!events.length && <Empty title="No activity matches these filters">Choose another actor, project, goal, or severity to broaden the view.</Empty>}
  </>;
}

function Systems({ open }: ViewProps) {
  const { state } = useStore();
  return <>
    <Intro eyebrow="OPERATIONS, WITH VISIBILITY" title="Systems" copy="Investigate incidents and inspect the tools available to your organization." />
    <div className="notice"><ShieldCheck size={18} /><span>Demo environment. Connectors are illustrative; no external services are connected.</span></div>
    <section><SectionTitle title="INCIDENTS" count={state.incidents.filter(incident => incident.status !== "resolved").length} /><div className="list-panel">{state.incidents.map(incident => <button className="list-row" key={incident.id} onClick={() => open({ type: "incident", id: incident.id })}><AlertTriangle size={20} className={incident.status === "resolved" ? "muted" : `${incident.severity}-text`} /><div className="row-main"><strong>{incident.title}</strong><span className="muted">{incident.project} · {incident.impact}</span><small className="muted">Detected {incident.detected} · {incident.agent}</small></div><StatusBadge status={incident.status} /><ArrowUpRight size={16} /></button>)}{!state.incidents.length && <Empty title="No recorded incidents">System events will appear here as they are recorded.</Empty>}</div></section>
    <section><SectionTitle title="CONNECTOR REGISTRY" count={state.connectors.length} /><div className="card-grid">{state.connectors.map(connector => <button key={connector.id} className="info-card" onClick={() => open({ type: "connector", id: connector.id })}><div className="goal-top"><Layers size={21} /><ArrowUpRight size={16} /></div><h3>{connector.name}</h3><StatusBadge status={connector.status} /><p>{connector.description}</p><small className="muted">{connector.capabilities.join(" · ")}</small></button>)}</div></section>
  </>;
}

function Files({ open }: ViewProps) {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const projects = [...new Set(state.files.map(file => file.project))].sort();
  const files = state.files.filter(file => (project === "all" || file.project === project) && `${file.name} ${file.kind} ${file.createdBy}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Intro eyebrow="THE OUTPUT, NOT JUST THE UPDATE" title="Files" copy="Artifacts attached to real goals. Open a file to inspect its contents." />
    <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search files or creators" /><SelectFilter label="Projects" value={project} onChange={setProject} options={projects.map(value => ({ value, label: value }))} /></div>
    <SectionTitle title="ARTIFACTS" count={files.length} />
    <div className="list-panel">{files.map(file => <button className="list-row" key={file.id} onClick={() => open({ type: "file", id: file.id })}><FileText size={21} /><div className="row-main"><strong>{file.name}</strong><span className="muted">{file.project} · {file.kind} · {file.size}</span><small className="muted">{state.goals.find(goal => goal.id === file.goalId)?.title || "Goal unavailable"} · {file.createdBy} · {dateLabel(file.createdAt)}</small></div><ArrowUpRight size={16} /></button>)}{!files.length && <Empty title="No matching files">Try another project or search term.</Empty>}</div>
  </>;
}

function AI({ command, navigate }: ViewProps) {
  const { state, dispatch, notify } = useStore();
  const readPermission = state.permissions.find(permission => permission.id === "read");
  const canRun = !state.agentPaused && readPermission?.value === "allowed";
  const reason = state.agentPaused ? "Resume the agent before running an inspection." : readPermission?.value === "approval" ? "Read access requires approval. Change the low-risk read permission to Allowed in Settings to run this demo." : readPermission?.value !== "allowed" ? "Read access is not allowed. Review permissions in Settings." : "Read-only inspection is authorized. No external action will be taken.";
  const events = state.activity.filter(event => event.category === "Agent").sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const projects = [...new Set(state.goals.map(goal => goal.project))];
  return <>
    <Intro eyebrow="SUPERVISED BY DESIGN" title="Waves AI" copy="Give direction. Inspect the plan. Keep control of what happens next."><button className="button primary" onClick={command}><Waves size={16} />Open command</button></Intro>
    <div className="notice"><Bot size={20} /><span><strong>Deterministic simulation, not an LLM.</strong> Commands use predefined local logic. No model, real terminal, browser automation, or external account is connected.</span></div>
    <div className="split-grid"><section className="panel"><SectionTitle title="COMPUTER AGENT"><Badge>{state.agentPaused ? "Paused" : "Supervised"}</Badge></SectionTitle><div className="stack"><Terminal size={27} /><h3>A visible, bounded operator.</h3><p className="muted">Simulate a read-only inspection of demo work. Pausing stops new inspections; it does not change existing tasks.</p><div className="toolbar"><button className="button" onClick={() => dispatch({ type: "AGENT_TOGGLE" })}>{state.agentPaused ? <Play size={15} /> : <Pause size={15} />}{state.agentPaused ? "Resume agent" : "Pause agent"}</button><button className="button primary" disabled={!canRun} aria-describedby="inspection-gate" onClick={() => { if (!canRun) return; dispatch({ type: "AGENT_RUN" }); notify("Simulated inspection completed. Review the agent audit below."); }}><Play size={15} />Run inspection</button></div><p id="inspection-gate" className={canRun ? "muted" : "warning-text"}>{reason}</p><span className="mono">{state.agentRuns} simulated inspections</span><TextLink onClick={() => navigate("Settings")}>Review permissions</TextLink></div></section>
    <section className="panel"><SectionTitle title="WORKSPACE SCOPE" /><p className="muted">Illustrative workspaces derived from your goals. Authorization applies only to local demo data, never to actual directories.</p><div className="stack">{projects.map(project => <div className="permission-row" key={project}><div className="row-main"><strong>{project}</strong><span className="muted">Demo workspace · read-only inspection</span></div><StatusBadge status={readPermission?.value || "denied"} /></div>)}</div></section></div>
    <section><SectionTitle title="AGENT AUDIT" count={events.length}><span className="muted">Chronological · oldest first</span></SectionTitle><div className="agent-console" aria-label="Simulated agent audit, not a terminal">{events.map(event => <div className="console-line" key={event.id}><time dateTime={event.timestamp} className="mono muted">{dateLabel(event.timestamp)}</time><div className="row-main"><strong>{event.actor} · {event.action}</strong><span>{event.result}</span><small className="muted">Target: {event.target} · Approval: {event.approvalState}</small></div></div>)}{!events.length && <Empty title="No agent actions recorded">Run an authorized inspection to start the audit trail.</Empty>}</div></section>
  </>;
}

function Settings() {
  const { state, dispatch, notify } = useStore();
  const [resetOpen, setResetOpen] = useState(false);
  const [notificationPreview, setNotificationPreview] = useState(true);
  return <>
    <Intro eyebrow="CLEAR BOUNDARIES. DELIBERATE CONTROL." title="Settings" copy="Decide what workers can do, and where a human must step in." />
    <section className="settings-section panel"><SectionTitle title="ACTION PERMISSIONS" /><p className="muted">Saved in this browser with the demo. High-risk actions always require approval or remain denied.</p>{state.permissions.map(permission => <div className="permission-row" key={permission.id}><div className="row-main"><strong>{permission.label} <Badge tone={permission.risk === "high" ? "warning" : "neutral"}>{permission.risk} risk</Badge></strong><span className="muted">{permission.description}</span></div><select aria-label={`${permission.label} permission`} value={permission.value} onChange={event => { dispatch({ type: "PERMISSION", id: permission.id, value: event.target.value as Permission["value"] }); notify(`${permission.label} permission updated.`); }}>{permission.risk === "low" && <option value="allowed">Allowed</option>}<option value="approval">Requires approval</option><option value="denied">Denied</option></select></div>)}</section>
    <section className="settings-section panel"><SectionTitle title="NOTIFICATION PREVIEW" /><div className="permission-row"><div className="row-main"><strong>Sample in-app notification</strong><span className="muted">Cosmetic preview only. This switch does not change alerts or delivery and resets when you leave this screen.</span></div><button className={`toggle ${notificationPreview ? "active" : ""}`} role="switch" aria-checked={notificationPreview} aria-label="Show sample notification" onClick={() => setNotificationPreview(!notificationPreview)}>{notificationPreview ? "On" : "Off"}</button></div>{notificationPreview && <div className="notice"><ShieldCheck size={18} /><span>Preview: a decision is ready for your review.</span></div>}</section>
    <section className="settings-section panel"><SectionTitle title="DEMO DATA" /><p className="muted">This prototype has no backend or authentication. Organization changes are stored locally in this browser.</p><button className="button danger" onClick={() => setResetOpen(true)}>Reset demo data</button></section>
    {resetOpen && <Modal title="Reset this workspace?" eyebrow="LOCAL DEMO DATA" onClose={() => setResetOpen(false)}><div className="stack"><p>This replaces your goals, work, decisions, permissions, and activity with the original demo. Your current local changes cannot be recovered.</p><p className="muted">No external accounts or files are affected.</p><div className="toolbar"><button className="button" onClick={() => setResetOpen(false)}>Keep my changes</button><button className="button danger" onClick={() => { dispatch({ type: "RESET" }); setResetOpen(false); notify("Demo data reset to the original workspace."); }}>Reset demo data</button></div></div></Modal>}
  </>;
}

export function Workspace({ screen, open, navigate, newGoal, command }: ViewProps & { screen: Screen }) {
  const props = { open, navigate, newGoal, command };
  switch (screen) {
    case "Goals": return <Goals {...props} />;
    case "Work": return <Work {...props} />;
    case "People": return <People {...props} />;
    case "Approvals": return <Approvals {...props} />;
    case "Activity": return <ActivityView {...props} />;
    case "Systems": return <Systems {...props} />;
    case "Files": return <Files {...props} />;
    case "AI": return <AI {...props} />;
    case "Settings": return <Settings />;
    default: return null;
  }
}
