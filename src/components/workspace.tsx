"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, FileText, Pause, Play, Plus, Search, ShieldCheck, Terminal, Users, Waves } from "lucide-react";
import { useStore } from "./store";
import { DevicePanel } from "./agent-live";
import { artifactDownloadUrl, clearOwnerToken, decideApproval, getDevices, getOwnerTokenMode, getPolicy, hideSecretParams, listApprovals, listArtifacts, putPolicy, setOwnerToken } from "../lib/agent-client";
import type { AgentApproval, DeviceStatus } from "../lib/agent-client";
import type { ArtifactMeta } from "../lib/agent-protocol";
import { CAPABILITIES, CAPABILITY_RISK, type Policy, type PolicyValue } from "../lib/agent-protocol";
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
  return <div className="filter-bar" role="group" aria-label={label}>{options.map(option => <button key={option} className={`filter-chip ${value === option ? "active" : ""}`} aria-pressed={value === option} onClick={() => onChange(option)}>{option.replaceAll("-", " ").toUpperCase()}</button>)}</div>;
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
    <Intro eyebrow="" title="Goals" copy=""><button className="button primary" onClick={newGoal}><Plus size={16} />New goal</button></Intro>
    <Filters label="Goal status" options={["All", "planning", "active", "completed"]} value={status} onChange={setStatus} />
    <SectionTitle title="Goals" count={goals.length} />
    <div className="card-grid">{goals.map(goal => {
      const tasks = state.tasks.filter(task => task.goalId === goal.id);
      const done = tasks.filter(task => task.status === "completed").length;
      const progress = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      return <button className="info-card goal-card" key={goal.id} onClick={() => open({ type: "goal", id: goal.id })}>
        <p className="eyebrow">{goal.project}</p><h3>{goal.title}</h3>
        <p className="muted">{done} / {tasks.length} tasks · Due {goal.deadline}</p>
        <div className="progress-label"><span>{progress}%</span></div><Progress value={progress} />
      </button>;
    })}</div>
    {!goals.length && <Empty title="No goals">Create a goal to set the next direction.</Empty>}
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
    <Intro eyebrow="" title="Work" copy=""><button className="button" onClick={newGoal}><Plus size={16} />New goal</button></Intro>
    <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search work" /><span className="muted" style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10 }}>{tasks.length} linked tasks</span></div>
    <Filters label="Task status" options={["All", "planning", "queued", "running", "blocked", "review", "completed"]} value={status} onChange={setStatus} />
    <div className="table-wrap panel"><table className="data-table"><thead><tr><th scope="col">TASK</th><th scope="col">OWNER</th><th scope="col">STATUS</th><th scope="col">DUE</th></tr></thead><tbody>{tasks.map(task => {
      const goal = state.goals.find(item => item.id === task.goalId)!;
      return <tr key={task.id}><td><div className="row-main"><button className="text-link" onClick={() => open({ type: "task", id: task.id })} style={{ fontWeight: 450 }}>{task.title}</button><small className="muted" style={{ fontSize: 10 }}>{task.project} · {goal.title}</small></div></td><td style={{ fontSize: 12 }}>{task.owner}</td><td><StatusBadge status={task.status} /></td><td className="mono" style={{ fontSize: 11 }}>{task.deadline}</td></tr>;
    })}</tbody></table>{!tasks.length && <Empty title="No work">Try another search or status.</Empty>}</div>
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
    <Intro eyebrow="" title="People" copy="" />
    <div className="metric-strip" style={{ border: '1px solid #141414', background: 'transparent' }}><div className="metric" style={{ background: 'transparent' }}><strong>{state.workers.filter(worker => ["Employee", "Contractor"].includes(worker.type)).length}</strong><span>People</span></div><div className="metric" style={{ background: 'transparent' }}><strong>{state.workers.filter(worker => ["AI agent", "Automated worker"].includes(worker.type)).length}</strong><span>Digital workers</span></div><div className="metric" style={{ background: 'transparent' }}><strong>{departments.length}</strong><span>Departments</span></div></div>
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

function summarizeParams(kind: string, params: Record<string, unknown>, max = 300): string {
  let text: string;
  try {
    text = JSON.stringify(hideSecretParams(kind, params ?? {})) ?? "";
  } catch {
    text = String(params ?? "");
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ComputerAgentApprovals() {
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await listApprovals();
        if (!cancelled) {
          setApprovals(next);
          setReachable(true);
        }
      } catch {
        if (!cancelled) setReachable(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const pending = approvals.filter(approval => approval.status === "pending");

  useEffect(() => {
    if (!pending.length) return;
    const timer = window.setInterval(async () => {
      try {
        setApprovals(await listApprovals());
        setReachable(true);
      } catch {
        setReachable(false);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending.length]);

  async function decide(approval: AgentApproval, decision: "approved" | "rejected") {
    const note = (notes[approval.id] || "").trim();
    if (decision === "rejected" && !note) return;
    setBusyId(approval.id);
    setError(null);
    try {
      await decideApproval(approval.id, decision, decision === "rejected" ? note : undefined);
      setApprovals(await listApprovals());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  return <section>
    <SectionTitle title="COMPUTER AGENT" count={pending.length} />
    {!reachable ? <div className="notice"><ShieldCheck size={18} /><span>Control plane unreachable. Computer-agent requests will appear here when the server is reachable.</span></div>
    : <div className="list-panel">{approvals.map(approval => <article className="list-row" key={approval.id}>
      <ShieldCheck size={20} />
      <div className="row-main">
        <span className="eyebrow">{approval.kind}</span>
        <strong>{approval.title}</strong>
        <span className="muted">{approval.reason}</span>
        <small className="mono muted">{summarizeParams(approval.kind, approval.params)}</small>
        <small className="muted">Requested by {approval.createdBy} · {dateLabel(approval.createdAt)}{approval.expiresAt ? ` · Expires ${dateLabel(approval.expiresAt)}` : ""}</small>
        {approval.status === "pending"
          ? <label className="detail-field"><span className="muted">Decision note (required to reject)</span><input aria-label={`Decision note for ${approval.title}`} placeholder="Why is this being rejected?" value={notes[approval.id] || ""} onChange={event => setNotes(current => ({ ...current, [approval.id]: event.target.value }))} /></label>
          : approval.note ? <small className="muted">Note: {approval.note}</small> : null}
      </div>
      {approval.status === "pending" ? <div className="toolbar">
        <button className="button small primary" disabled={busyId === approval.id} onClick={() => decide(approval, "approved")}>Approve</button>
        <button className="button small danger" disabled={busyId === approval.id || !(notes[approval.id] || "").trim()} onClick={() => decide(approval, "rejected")}>Reject</button>
      </div> : <StatusBadge status={approval.status} />}
    </article>)}{!approvals.length && <Empty title="No computer-agent requests">Workstation requests that need a human decision will appear here.</Empty>}</div>}
    {error && <p className="error-text">{error}</p>}
  </section>;
}

function Approvals({ open }: ViewProps) {
  const { state } = useStore();
  const [view, setView] = useState("Pending");
  const approvals = state.approvals.filter(approval => view === "Pending" ? approval.status === "pending" : approval.status !== "pending");
  return <>
    <Intro eyebrow="" title="Approvals" copy="Review and decide." />
    <Filters label="Approval view" options={["Pending", "History"]} value={view} onChange={setView} />
    <SectionTitle title={view === "Pending" ? "PENDING" : "HISTORY"} count={approvals.length} />
    <div className="list-panel">{approvals.map(approval => <button className="list-row" key={approval.id} onClick={() => open({ type: "approval", id: approval.id })}><div className="row-main"><span className="eyebrow">{approval.project}</span><strong>{approval.title}</strong><span className="muted" style={{ fontSize: 11 }}>{approval.what}</span></div><span className="mono" style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{approval.status}</span><span className="muted" style={{ fontSize: 11, marginLeft: 12 }}>Review</span></button>)}{!approvals.length && <Empty title={view === "Pending" ? "Nothing pending" : "No history"}>{view === "Pending" ? "Requests will appear here." : "Decisions will appear here."}</Empty>}</div>
    <ComputerAgentApprovals />
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
    <Intro eyebrow="" title="Activity" copy="" />
    <div className="toolbar" style={{ justifyContent: 'space-between' }}><span className="eyebrow" style={{ letterSpacing: '0.14em' }}>ACTIVITY</span><button className="button small" onClick={exportAudit}>Export audit</button></div>
    <div className="toolbar"><Filters label="Activity category" options={["All", "Person", "Agent", "System", "Goal"]} value={category} onChange={setCategory} /><button className={`filter-chip ${audit ? "active" : ""}`} aria-pressed={audit} onClick={() => setAudit(!audit)}>Audit table</button></div>
    <div className="filter-bar"><SelectFilter label="Severity" value={severity} onChange={setSeverity} options={options(["info", "success", "warning", "error"])} /><SelectFilter label="Actor" value={actor} onChange={setActor} options={options(state.activity.map(event => event.actor))} /><SelectFilter label="Project" value={project} onChange={setProject} options={options(state.activity.flatMap(event => event.project ? [event.project] : []))} /><SelectFilter label="Goal" value={goal} onChange={setGoal} options={state.goals.map(item => ({ value: item.id, label: item.title }))} /></div>
    <SectionTitle title="Audit trail" count={events.length} />
    {audit ? <div className="table-wrap panel"><table className="data-table"><thead><tr>{["Actor", "Timestamp", "Target", "Action", "Result", "Approval state"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{events.map(event => <tr key={event.id}><td>{event.actor}<br /><small className="muted">{event.category}</small></td><td><time dateTime={event.timestamp} className="mono">{event.timestamp}</time></td><td>{event.target}</td><td>{event.action}</td><td>{event.result}</td><td>{event.approvalState}</td></tr>)}</tbody></table></div> : <div className="list-panel">{events.map(event => {
      const selection = selectionFor(event);
      return <article className="list-row" key={event.id} style={{ padding: '20px 0', borderBottom: '1px solid #141414' }}><div className="row-main"><strong style={{ fontSize: 13, fontWeight: 420 }}>{event.actor} — {event.action}</strong><span className="muted" style={{ fontSize: 11, marginTop: 4 }}>{event.result}</span><small className="muted" style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', marginTop: 6 }}>{event.project || event.target} · {event.approvalState}</small></div><div style={{ textAlign: 'right' }}><time dateTime={event.timestamp} title={event.timestamp} className="mono" style={{ fontSize: 10, color: '#5a5a5a' }}>{dateLabel(event.timestamp)}</time>{selection && <div style={{ marginTop: 6 }}><TextLink onClick={() => open(selection)}><span style={{ fontSize: 10 }}>View {selection.type}</span></TextLink></div>}</div></article>;
    })}</div>}
    {!events.length && <Empty title="No activity">No events match these filters.</Empty>}
  </>;
}

function Systems({ open }: ViewProps) {
  const { state } = useStore();
  return <>
    <Intro eyebrow="" title="Systems" copy="" />
    <section><SectionTitle title="Incidents" count={state.incidents.filter(incident => incident.status !== "resolved").length} /><div className="list-panel">{state.incidents.map(incident => <button className="list-row" key={incident.id} onClick={() => open({ type: "incident", id: incident.id })}><div className="row-main"><span className="eyebrow" style={{ color: incident.severity === 'error' ? 'var(--error)' : 'var(--warning)', fontSize: 9 }}>{incident.severity.toUpperCase()}</span><strong style={{ fontSize: 13 }}>{incident.title}</strong><span className="muted" style={{ fontSize: 11 }}>{incident.impact}</span></div><span className="mono" style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{incident.status}</span></button>)}{!state.incidents.length && <Empty title="No incidents">System events will appear here.</Empty>}</div></section>
    <section><SectionTitle title="Connectors" count={state.connectors.length} /><div style={{ borderTop: '1px solid #141414' }}>{state.connectors.map(connector => <button key={connector.id} className="list-row" onClick={() => open({ type: "connector", id: connector.id })} style={{ padding: '16px 0', borderBottom: '1px solid #141414' }}><div className="row-main"><strong style={{ fontSize: 13 }}>{connector.name}</strong><span className="mono" style={{ fontSize: 10, color: '#888', textTransform: 'uppercase' }}>{connector.status}</span></div><span className="muted" style={{ fontSize: 10 }}>{connector.capabilities.slice(0, 3).join(" · ")}</span></button>)}</div></section>
  </>;
}

function formatBytes(size: unknown): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AgentArtifacts() {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const tokenMode = getOwnerTokenMode();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await listArtifacts();
        if (!cancelled) {
          setArtifacts(next);
          setReachable(true);
        }
      } catch {
        if (!cancelled) {
          setArtifacts([]);
          setReachable(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return <section>
    <SectionTitle title="AGENT ARTIFACTS" count={artifacts?.length ?? 0} />
    {!reachable && <div className="notice"><FileText size={18} /><span>Agent artifacts could not be loaded. The control plane is unreachable.</span></div>}
    {tokenMode && <div className="notice"><ShieldCheck size={18} /><span>Owner-token mode is on. Direct download links are hidden; fetch artifacts with an authorized request instead.</span></div>}
    {artifacts && artifacts.length > 0 && <div className="list-panel">{artifacts.map(artifact => <article className="list-row" key={artifact.id}>
      <FileText size={21} />
      <div className="row-main"><strong>{artifact.name}</strong><span className="muted">{artifact.kind} · {formatBytes(artifact.size)} · sha {typeof artifact.sha256 === "string" ? artifact.sha256.slice(0, 8) : "—"}</span><small className="muted">{dateLabel(artifact.createdAt)}{artifact.jobId ? ` · job ${artifact.jobId}` : ""}</small></div>
      {!tokenMode && <a className="text-link" href={artifactDownloadUrl(artifact.id)} download>Download</a>}
    </article>)}</div>}
    {artifacts && !artifacts.length && reachable && <Empty title="No agent artifacts">Files produced by workstation jobs will appear here.</Empty>}
  </section>;
}

function Files({ open }: ViewProps) {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const projects = [...new Set(state.files.map(file => file.project))].sort();
  const files = state.files.filter(file => (project === "all" || file.project === project) && `${file.name} ${file.kind} ${file.createdBy}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Intro eyebrow="" title="Files" copy="" />
    <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search files" /><SelectFilter label="Project" value={project} onChange={setProject} options={projects.map(value => ({ value, label: value }))} /></div>
    <SectionTitle title="Artifacts" count={files.length} />
    <div className="list-panel">{files.map(file => <button className="list-row" key={file.id} onClick={() => open({ type: "file", id: file.id })}><div className="row-main"><strong style={{ fontSize: 13 }}>{file.name}</strong><span className="muted" style={{ fontSize: 11 }}>{file.project} · {file.kind}</span></div><span className="mono" style={{ fontSize: 10, color: '#5a5a5a' }}>{dateLabel(file.createdAt)}</span></button>)}{!files.length && <Empty title="No files">No matching files.</Empty>}</div>
    <AgentArtifacts />
  </>;
}

function AI({ command, navigate }: ViewProps) {
  const { state, dispatch, notify } = useStore();
  const [liveOnline, setLiveOnline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const devices: DeviceStatus[] = await getDevices();
        if (!cancelled) setLiveOnline(devices.some(device => device.online));
      } catch {
        if (!cancelled) setLiveOnline(false);
      }
    }
    check();
    const timer = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const readPermission = state.permissions.find(permission => permission.id === "read");
  const canRun = !state.agentPaused && readPermission?.value === "allowed";
  const reason = state.agentPaused ? "Resume the agent before running an inspection." : readPermission?.value === "approval" ? "Read access requires approval. Change the low-risk read permission to Allowed in Settings to run this demo." : readPermission?.value !== "allowed" ? "Read access is not allowed. Review permissions in Settings." : "Read-only inspection is authorized. No external action will be taken.";
  const events = state.activity.filter(event => event.category === "Agent").sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const projects = [...new Set(state.goals.map(goal => goal.project))];
  return <>
    <Intro eyebrow="" title="AI Orchestration" copy=""><button className="button" onClick={command}><Waves size={14} />Open command</button></Intro>
    <div style={{ marginBottom: 32, padding: '16px 0', borderBottom: '1px solid #141414' }}>
      <span className="eyebrow" style={{ fontSize: 9, letterSpacing: '0.14em' }}>{liveOnline ? 'Device connected' : 'No live device'}</span>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>{liveOnline ? 'Jobs execute on the authorized workstation sandbox.' : 'Pair a device for live execution.'}</p>
    </div>
    <DevicePanel />
    <div className="split-grid"><section className="panel"><SectionTitle title="COMPUTER AGENT"><Badge>{state.agentPaused ? "Paused" : "Supervised"}</Badge></SectionTitle><div className="stack"><Terminal size={27} /><h3>A visible, bounded operator.</h3><p className="muted">Simulate a read-only inspection of demo work. Pausing stops new inspections; it does not change existing tasks.</p>{!liveOnline && <div className="toolbar"><button className="button" onClick={() => dispatch({ type: "AGENT_TOGGLE" })}>{state.agentPaused ? <Play size={15} /> : <Pause size={15} />}{state.agentPaused ? "Resume agent" : "Pause agent"}</button><button className="button primary" disabled={!canRun} aria-describedby="inspection-gate" onClick={() => { if (!canRun) return; dispatch({ type: "AGENT_RUN" }); notify("Simulated inspection completed. Review the agent audit below."); }}><Play size={15} />Run inspection</button></div>}<p id="inspection-gate" className={canRun ? "muted" : "warning-text"}>{reason}</p><span className="mono">{state.agentRuns} simulated inspections</span><TextLink onClick={() => navigate("Settings")}>Review permissions</TextLink></div></section>
    <section className="panel"><SectionTitle title="WORKSPACE SCOPE" /><p className="muted">Illustrative workspaces derived from your goals. Authorization applies only to local demo data, never to actual directories.</p><div className="stack">{projects.map(project => <div className="permission-row" key={project}><div className="row-main"><strong>{project}</strong><span className="muted">Demo workspace · read-only inspection</span></div><StatusBadge status={readPermission?.value || "denied"} /></div>)}</div></section></div>
    <section><SectionTitle title="AGENT AUDIT" count={events.length}><span className="muted">Chronological · oldest first</span></SectionTitle><div className="agent-console" aria-label="Simulated agent audit, not a terminal">{events.map(event => <div className="console-line" key={event.id}><time dateTime={event.timestamp} className="mono muted">{dateLabel(event.timestamp)}</time><div className="row-main"><strong>{event.actor} · {event.action}</strong><span>{event.result}</span><small className="muted">Target: {event.target} · Approval: {event.approvalState}</small></div></div>)}{!events.length && <Empty title="No agent actions recorded">Run an authorized inspection to start the audit trail.</Empty>}</div></section>
    <p className="muted" style={{ fontSize: 10, marginTop: 32, borderTop: '1px solid #141414', paddingTop: 12 }}>Deterministic simulation — no LLM, no external account. Live data resumes when the server is reachable.</p>
  </>;
}

function parseDomainLines(text: string): string[] {
  return text.split("\n").map(line => line.trim().toLowerCase()).filter(line => line.length > 0);
}

function ComputerAgentPolicy() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy["capabilities"] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [allowedText, setAllowedText] = useState("");
  const [blockedText, setBlockedText] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [tokenNote, setTokenNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reachable, setReachable] = useState(true);

  function applyPolicy(next: Policy) {
    setPolicy(next);
    setDraft({ ...next.capabilities });
    setRoots(Array.isArray(next.roots) ? [...next.roots] : []);
    setAllowedText(Array.isArray(next.domains?.allowed) ? next.domains.allowed.join("\n") : "");
    setBlockedText(Array.isArray(next.domains?.blocked) ? next.domains.blocked.join("\n") : "");
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await getPolicy();
        if (!cancelled) {
          applyPolicy(next);
          setTokenSet(getOwnerTokenMode());
          setReachable(true);
        }
      } catch {
        if (!cancelled) {
          setReachable(false);
          setTokenSet(getOwnerTokenMode());
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function addRoot() {
    const trimmed = newRoot.trim();
    if (!trimmed) {
      setError("Root path is required.");
      return;
    }
    setError(null);
    setRoots(current => [...current, trimmed]);
    setNewRoot("");
    setSaved(false);
  }

  function removeRoot(index: number) {
    setRoots(current => current.filter((_, i) => i !== index));
    setSaved(false);
  }

  function handleSetToken() {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setOwnerToken(trimmed);
    setTokenInput("");
    setTokenSet(true);
    setTokenNote("Owner token saved in this browser.");
  }

  function handleClearToken() {
    clearOwnerToken();
    setTokenInput("");
    setTokenSet(false);
    setTokenNote("Owner token cleared.");
  }

  async function save() {
    if (!policy || !draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await putPolicy({
        version: 2,
        capabilities: draft,
        roots,
        domains: { allowed: parseDomainLines(allowedText), blocked: parseDomainLines(blockedText) },
      });
      applyPolicy(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return <section className="settings-section panel">
    <SectionTitle title="COMPUTER-AGENT POLICY" />
    {!reachable && !policy ? <div className="notice"><ShieldCheck size={18} /><span>Control plane unreachable. Computer-agent policy cannot be loaded right now.</span></div>
    : !policy || !draft ? <p className="muted">Loading computer-agent policy…</p>
    : <div className="stack">
      <p className="muted">Live workstation enforcement. High-risk capabilities can never be silently allowed.</p>
      {(["low", "medium", "high"] as const).map(risk => <div key={risk} className="stack">
        <SectionTitle title={`${risk.toUpperCase()} RISK`}><Badge tone={risk === "high" ? "warning" : "neutral"}>{risk} risk</Badge></SectionTitle>
        {CAPABILITIES.filter(capability => CAPABILITY_RISK[capability] === risk).map(capability => <div className="permission-row" key={capability}>
          <div className="row-main"><strong>{capability}</strong></div>
          <select aria-label={`${capability} policy`} value={draft[capability]} onChange={event => {
            const value = event.target.value as PolicyValue;
            setDraft(current => current ? { ...current, [capability]: value } : current);
            setSaved(false);
          }}>
            {risk !== "high" && <option value="allowed">Allowed</option>}
            <option value="approval">Requires approval</option>
            <option value="denied">Denied</option>
          </select>
        </div>)}
      </div>)}
      {error && <p className="error-text">{error}</p>}
      {saved && <p className="muted">Policy saved.</p>}
      <SectionTitle title="AUTHORIZED ROOTS" />
      <p className="muted">Every file job must resolve inside one of these roots. Empty means the server workspace default applies. The server validates that each entry is absolute.</p>
      {roots.length ? <div className="list-panel">{roots.map((root, index) => <div className="list-row" key={`${root}-${index}`}>
        <div className="row-main"><span className="mono">{root}</span></div>
        <button className="button small" aria-label={`Remove root ${root}`} onClick={() => removeRoot(index)}>Remove</button>
      </div>)}</div> : <p className="muted">No extra roots configured.</p>}
      <div className="toolbar">
        <label className="detail-field"><span className="muted">Add root</span><input aria-label="Add authorized root" placeholder="C:\work\project" value={newRoot} onChange={event => setNewRoot(event.target.value)} /></label>
        <button className="button small" onClick={addRoot}>Add</button>
      </div>
      <SectionTitle title="BROWSER DOMAINS" />
      <p className="muted">One host per line. Entries are trimmed and lowercased before saving; the server validates each host.</p>
      <div className="toolbar">
        <label className="detail-field"><span className="muted">Allowed domains</span><textarea aria-label="Allowed domains, one per line" rows={4} value={allowedText} onChange={event => { setAllowedText(event.target.value); setSaved(false); }} /></label>
        <label className="detail-field"><span className="muted">Blocked domains</span><textarea aria-label="Blocked domains, one per line" rows={4} value={blockedText} onChange={event => { setBlockedText(event.target.value); setSaved(false); }} /></label>
      </div>
      <SectionTitle title="OWNER TOKEN" />
      <p className="muted">Owner&apos;s browser only. Required only when the server sets WAVES_OWNER_TOKEN. Stored in this browser only and sent as an Authorization header with control-plane requests.</p>
      <div className="toolbar">
        <label className="detail-field"><span className="muted">{tokenSet ? "Owner token is set" : "Owner token"}</span><input type="password" aria-label="Owner token" placeholder={tokenSet ? "••••••••" : "Paste owner token"} value={tokenInput} onChange={event => setTokenInput(event.target.value)} /></label>
        <button className="button small primary" disabled={!tokenInput.trim()} onClick={handleSetToken}>Set</button>
        <button className="button small" disabled={!tokenSet && !tokenInput} onClick={handleClearToken}>Clear</button>
      </div>
      {tokenNote && <p className="muted">{tokenNote}</p>}
      <div className="toolbar"><button className="button primary" disabled={saving || !draft} onClick={save}>{saving ? "Saving…" : "Save policy"}</button></div>
    </div>}
  </section>;
}

function Settings() {
  const { state, dispatch, notify } = useStore();
  const [resetOpen, setResetOpen] = useState(false);
  const [notificationPreview, setNotificationPreview] = useState(true);
  return <>
    <Intro eyebrow="" title="Settings" copy="" />
    <section className="settings-section panel"><SectionTitle title="Permissions" /><p className="muted" style={{ fontSize: 11, marginBottom: 16 }}>Saved in this browser.</p>{state.permissions.map(permission => <div className="permission-row" key={permission.id} style={{ padding: '12px 0', borderBottom: '1px solid #141414' }}><div className="row-main"><strong style={{ fontSize: 12, fontWeight: 450 }}>{permission.label}</strong><span className="mono" style={{ fontSize: 9, color: '#5a5a5a', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{permission.risk} risk</span></div><select aria-label={`${permission.label} permission`} value={permission.value} onChange={event => { dispatch({ type: "PERMISSION", id: permission.id, value: event.target.value as Permission["value"] }); notify(`${permission.label} permission updated.`); }} style={{ fontSize: 11, minWidth: 140 }}>{permission.risk === "low" && <option value="allowed">Allowed</option>}<option value="approval">Approval required</option><option value="denied">Denied</option></select></div>)}</section>
    <ComputerAgentPolicy />
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
