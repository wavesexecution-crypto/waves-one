"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, CheckCheck, Circle, FileText, GitBranch, LockKeyhole, Play, Send, ShieldCheck, Sparkles, Terminal, Waves } from "lucide-react";
import { canComplete, planGoal, type Plan } from "../lib/model";
import { useStore } from "./store";
import { Avatar, Badge, Field, Modal, Progress, StatusBadge, dateLabel } from "./ui";
import type { Screen, Selection } from "./overview";

export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function GoalFlow({ close, initial = "", onCreated }: { close: () => void; initial?: string; onCreated: (id: string) => void }) {
  const { dispatch, notify } = useStore();
  const [input, setInput] = useState(initial);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  function generate() {
    try { setPlan(planGoal(input)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Enter a goal between 1 and 500 characters."); }
  }
  return <Modal title={plan ? "A direction. Now a plan." : "What should Waves achieve?"} eyebrow="NEW GOAL" onClose={close} wide>
    <div className="notice"><Waves size={16} /><span>Local simulation · Plans use reviewable templates, not a live AI model.</span></div>
    {!plan ? <form onSubmit={e => { e.preventDefault(); generate(); }}><label className="input-label" htmlFor="goal-input">Describe the outcome</label><textarea id="goal-input" autoFocus value={input} onChange={e => setInput(e.target.value)} maxLength={500} rows={5} placeholder="Get SEAI ready for Shopify App Store submission." required /><div className="input-help"><span>Give direction. The plan will connect every task to this outcome.</span><span>{input.length}/500</span></div>{error && <p role="alert" className="error-text">{error}</p>}<div className="suggestions"><span className="eyebrow">TRY A DIRECTION</span>{["Get SEAI ready for Shopify App Store submission", "Get the new Waves website ready for launch", "Prepare the infrastructure upgrade"].map(text => <button className="suggestion" type="button" key={text} onClick={() => setInput(text)}>{text}<ArrowUpRight size={14} /></button>)}</div><div className="modal-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={!input.trim()}>Create execution plan<ArrowRight size={16} /></button></div></form> : <>
      <div className="plan-summary"><Badge>PLAN FOR REVIEW</Badge><h3>{plan.goal.title}</h3><p>{plan.goal.description}</p><div className="meta-line"><span>{plan.tasks.length} linked tasks</span><span>Suggested owners</span><span>Approval-gated release</span></div></div>
      <div className="plan-tree">{plan.tasks.map((task, i) => <div key={task.id}><span className="plan-step">{String(i + 1).padStart(2, "0")}</span><div><strong>{task.title}</strong><p>{task.owner} · {task.priority} priority · {task.deadline}</p><small>{task.dependencies.length ? `Depends on ${task.dependencies.length} earlier task(s)` : "Ready to begin"}{task.approvalRequired && " · Owner approval required"}</small></div>{task.approvalRequired && <LockKeyhole size={15} />}</div>)}</div>
      <p className="muted">Review the suggested work before delegating. No external worker or system will be contacted.</p><div className="modal-actions"><button className="button" onClick={() => setPlan(null)}>Edit direction</button><button className="button" onClick={() => { dispatch({ type: "ADD_GOAL", plan }); notify("Goal saved as a draft. No work has started."); onCreated(plan.goal.id); }}>Save draft</button><button className="button primary" onClick={() => { dispatch({ type: "ADD_GOAL", plan }); dispatch({ type: "DELEGATE", id: plan.goal.id }); notify("Plan delegated to simulated workers."); onCreated(plan.goal.id); }}>Delegate plan<ArrowRight size={16} /></button></div>
    </>}
  </Modal>;
}

export function DetailFlow({ selection, close, open }: { selection: Selection; close: () => void; open: (s: Selection) => void }) {
  const { state, dispatch, notify } = useStore();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const kind = selection.type;
  if (kind === "approval") {
    const item = state.approvals.find(a => a.id === selection.id);
    if (!item) return null;
    function decide(decision: "approved" | "rejected" | "changes-requested") {
      if (decision !== "approved" && !note.trim()) { setError("Add a reason so the worker knows what to change."); return; }
      dispatch({ type: "DECIDE", id: selection.id, decision, note });
      notify(decision === "approved" ? "Approved. Execution remains a separate simulation." : decision === "rejected" ? "Rejected. Execution is blocked." : "Changes requested. Work is held for revision.");
      close();
    }
    return <Modal title={item.title} eyebrow={`${item.project} / DECISION`} onClose={close} wide>
      <div className="detail-status"><StatusBadge status={item.status} /><span>{item.requestedBy} · {dateLabel(item.createdAt)}</span></div>
      <div className="detail-grid"><Field label="WHAT">{item.what}</Field><Field label="WHY">{item.why}</Field><Field label="IMPACT">{item.impact}</Field><Field label="RISK">{item.risk}</Field><Field label="COST">{item.cost || "No additional cost"}</Field><Field label="CONNECTED GOAL"><button className="text-link" onClick={() => open({ type: "goal", id: item.goalId })}>{state.goals.find(g => g.id === item.goalId)?.title}<ArrowUpRight size={14} /></button></Field></div>
      <Field label="EVIDENCE"><div className="evidence-box">{item.evidence.map((e, i) => <div key={i}><FileText size={15} /><span>{e}</span></div>)}</div></Field>
      <div className="notice"><ShieldCheck size={17} /><span>This decision updates local demo state only. It cannot deploy, spend money, or grant real access.</span></div>
      {item.status === "pending" ? <><label className="input-label" htmlFor="decision-note">Decision note <span className="muted">(required for rejection or changes)</span></label><textarea id="decision-note" rows={3} maxLength={1000} value={note} onChange={e => { setNote(e.target.value); setError(""); }} placeholder="Anything the team should know?" />{error && <p className="error-text" role="alert">{error}</p>}<div className="modal-actions decision-actions"><button className="button danger" onClick={() => decide("rejected")}>Reject</button><button className="button" onClick={() => decide("changes-requested")}>Request changes</button><button className="button primary" onClick={() => decide("approved")}><Check size={16} />Approve</button></div></> : <>{item.note && <Field label="YOUR DECISION NOTE">{item.note}</Field>}{item.status === "approved" && <div className="modal-actions"><button className="button primary" onClick={() => { dispatch({ type: "EXECUTE_APPROVED", id: item.id }); notify("Simulated execution completed and verified. Audit updated."); }}><Play size={16} />Simulate approved execution</button></div>}{item.status === "completed" && <div className="result-banner"><CheckCheck size={18} />Simulated execution verified. No external system was changed.</div>}</>}
    </Modal>;
  }
  if (kind === "goal") {
    const goal = state.goals.find(g => g.id === selection.id);
    if (!goal) return null;
    const tasks = state.tasks.filter(t => t.goalId === goal.id);
    const completed = tasks.filter(t => t.status === "completed").length;
    const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
    return <Modal title={goal.title} eyebrow="DIRECTION → EXECUTION" onClose={close} wide><div className="detail-status"><StatusBadge status={goal.status} /><span>{goal.owner} · {goal.deadline}</span></div><p className="detail-description">{goal.description}</p><div className="progress-label"><span>{completed} of {tasks.length} tasks verified</span><strong>{percent}%</strong></div><Progress value={percent} /><div className="execution-loop">{["Goal", "Plan", "Delegate", "Execute", "Verify", "Approve", "Complete"].map((stage, i) => <span className={i < (goal.status === "completed" ? 7 : goal.status === "planning" ? 2 : 4) ? "done" : ""} key={stage}>{stage}{i < 6 && <ArrowRight size={10} />}</span>)}</div><Field label="EXECUTION PLAN"><div className="task-list">{tasks.map(task => <button key={task.id} className="list-row" onClick={() => open({ type: "task", id: task.id })}>{task.status === "completed" ? <Check size={16} className="success-text" /> : <Circle size={15} />}<span className="row-main"><strong>{task.title}</strong><span>{task.owner} · {task.deadline}{task.dependencies.length > 0 && ` · ${task.dependencies.length} dependencies`}</span></span><StatusBadge status={task.status} /><ArrowUpRight size={14} /></button>)}</div></Field><Field label="DELIVERABLES"><div className="stack">{state.files.filter(f => f.goalId === goal.id).map(file => <button key={file.id} className="list-row" onClick={() => open({ type: "file", id: file.id })}><FileText size={16} /><span>{file.name}</span><ArrowUpRight size={14} /></button>)}{!state.files.some(f => f.goalId === goal.id) && <p className="muted">Verified outputs will appear here as work completes.</p>}</div></Field>{goal.status === "planning" && <div className="modal-actions"><button className="button primary" onClick={() => { dispatch({ type: "DELEGATE", id: goal.id }); notify("Plan delegated. Eligible simulated tasks are now running."); }}>Delegate plan<ArrowRight size={16} /></button></div>}</Modal>;
  }
  if (kind === "task") {
    const task = state.tasks.find(t => t.id === selection.id);
    if (!task) return null;
    const goal = state.goals.find(g => g.id === task.goalId);
    return <Modal title={task.title} eyebrow={`${task.project} / WORK`} onClose={close} wide><div className="detail-status"><StatusBadge status={task.status} /><Badge>{task.priority} priority</Badge></div><div className="detail-grid"><Field label="OWNER">{task.owner}</Field><Field label="DEADLINE">{task.deadline}</Field><Field label="WHY THIS WORK EXISTS"><button className="text-link" onClick={() => open({ type: "goal", id: task.goalId })}>{goal?.title}<ArrowUpRight size={14} /></button><p>{goal?.description}</p></Field><Field label="APPROVAL">{task.approvalRequired ? "Explicit owner decision required before completion" : "May complete within authorized scope"}</Field></div><Field label="DEPENDENCIES">{task.dependencies.length ? task.dependencies.map(id => { const dependency = state.tasks.find(t => t.id === id); return <button className="list-row" key={id} onClick={() => open({ type: "task", id })}><GitBranch size={15} /><span className="row-main">{dependency?.title || id}</span><StatusBadge status={dependency?.status || "queued"} /></button>; }) : <p className="muted">No dependencies. This task can progress independently.</p>}</Field><Field label="OUTPUT"><pre className="artifact-preview">{task.output || "No verified output yet."}</pre></Field><Field label="ACTIVITY">{task.activity.map((line, i) => <div key={i} className="activity-line"><span className="status-dot neutral" />{line}</div>)}</Field>{task.status === "blocked" && <><div className="notice warning"><LockKeyhole size={16} />Waiting for authorized sandbox access. Do not paste credentials here.</div><label className="input-label" htmlFor="unblock-note">How did you resolve the blocker?</label><textarea id="unblock-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Sandbox access assigned through the credential manager" maxLength={1000} rows={3} /><div className="modal-actions"><button disabled={!note.trim()} className="button primary" onClick={() => { dispatch({ type: "UNBLOCK", id: task.id, note }); notify("Blocker resolved in the demo. Task resumed."); }}>Resolve blocker<ArrowRight size={16} /></button></div></>}{["running", "review", "queued"].includes(task.status) && <><p className="muted small-copy">{canComplete(task, state) ? "This simulates output verification and records completion in the audit trail." : "Complete dependencies and obtain any required approval before verifying this task."}</p>{task.approvalRequired && state.approvals.filter(a => a.goalId === task.goalId && a.status === "pending").map(a => <button className="button" key={a.id} onClick={() => open({ type: "approval", id: a.id })}>Review {a.title}<ArrowUpRight size={14} /></button>)}<div className="modal-actions"><button className="button primary" disabled={!canComplete(task, state)} onClick={() => { dispatch({ type: "COMPLETE_TASK", id: task.id }); notify("Output verified and task completed in the simulation."); }}><CheckCheck size={16} />Verify & complete simulation</button></div></>}</Modal>;
  }
  if (kind === "worker") {
    const worker = state.workers.find(w => w.id === selection.id);
    if (!worker) return null;
    const tasks = state.tasks.filter(t => t.owner === worker.name);
    return <Modal title={worker.name} eyebrow={`${worker.department} / PEOPLE`} onClose={close}><div className="worker-profile"><Avatar initials={worker.initials} agent={worker.type === "AI agent"} /><div><h3>{worker.role}</h3><p>{worker.type}</p></div><StatusBadge status={worker.status} /></div><div className="detail-grid"><Field label="COMPLETED TASKS">{worker.completed}</Field><Field label="PROJECTS">{worker.projects.join(" · ")}</Field></div><Field label="CURRENT WORK">{tasks.filter(t => t.status !== "completed").map(task => <button className="list-row" key={task.id} onClick={() => open({ type: "task", id: task.id })}><span className="row-main"><strong>{task.title}</strong><span>{state.goals.find(g => g.id === task.goalId)?.title} · {task.deadline}</span></span><StatusBadge status={task.status} /></button>)}{!tasks.some(t => t.status !== "completed") && <p className="muted">Available for the next goal.</p>}</Field><Field label="PERMISSIONS">{worker.permissions.map(p => <span className="permission-tag" key={p}>{p}</span>)}</Field><Field label="RECENT ACTIVITY">{state.activity.filter(e => e.actor === worker.name).slice(0, 5).map(e => <div className="activity-line" key={e.id}><span className="mono">{dateLabel(e.timestamp)}</span>{e.action}</div>)}{!state.activity.some(e => e.actor === worker.name) && <p className="muted">No recent activity recorded.</p>}</Field></Modal>;
  }
  if (kind === "incident") {
    const incident = state.incidents.find(i => i.id === selection.id);
    if (!incident) return null;
    return <Modal title={incident.title} eyebrow={`${incident.project} / INCIDENT`} onClose={close}><div className="detail-status"><Badge tone={incident.status === "resolved" ? "success" : incident.severity}>{incident.status === "resolved" ? "Resolved" : incident.severity === "error" ? "Production error" : "Infrastructure warning"}</Badge><span>{incident.detected}</span></div><Field label="IMPACT">{incident.impact}</Field><div className="detail-grid"><Field label="OWNER">{incident.agent}</Field><Field label="STATUS"><StatusBadge status={incident.status} /></Field></div><Field label="INVESTIGATION TIMELINE">{incident.timeline.map((line, i) => <div className="activity-line" key={i}><span className="timeline-index">{i + 1}</span>{line}</div>)}</Field><div className="notice">Incident data is simulated. Resolving it does not change a production service.</div>{incident.status !== "resolved" && <div className="modal-actions"><button className="button primary" onClick={() => { dispatch({ type: "RESOLVE_INCIDENT", id: incident.id }); notify("Simulated recovery verified. Incident resolved and audited."); }}><ShieldCheck size={16} />Simulate recovery & verify</button></div>}</Modal>;
  }
  if (kind === "file") {
    const file = state.files.find(f => f.id === selection.id);
    if (!file) return null;
    return <Modal title={file.name} eyebrow="FILES / VERIFIED PROVENANCE" onClose={close} wide><div className="detail-grid"><Field label="CREATED BY">{file.createdBy}</Field><Field label="CREATED">{dateLabel(file.createdAt)}</Field><Field label="GOAL"><button className="text-link" onClick={() => open({ type: "goal", id: file.goalId })}>{state.goals.find(g => g.id === file.goalId)?.title}<ArrowUpRight size={14} /></button></Field><Field label="FILE">{file.kind} · {file.size} · Local demo artifact</Field></div><pre className="artifact-preview document-preview">{file.content}</pre><div className="modal-actions"><button className="button primary" onClick={() => { download(file.name, file.content); notify("Demo artifact downloaded."); }}><FileText size={16} />Download artifact</button></div></Modal>;
  }
  if (kind === "connector") {
    const connector = state.connectors.find(c => c.id === selection.id);
    if (!connector) return null;
    return <Modal title={connector.name} eyebrow="SYSTEMS / CONNECTOR" onClose={close}><Badge>{connector.status.replaceAll("-", " ")}</Badge><p className="detail-description">{connector.description}</p><Field label="PLANNED CAPABILITIES">{connector.capabilities.map(capability => <div className="activity-line" key={capability}><Circle size={12} />{capability}</div>)}</Field><div className="notice"><LockKeyhole size={18} /><span>No service is connected. The connector contract is represented in local demo data; OAuth, credentials, and backend execution are intentionally not implemented.</span></div></Modal>;
  }
  return null;
}

type Message = { role: "user" | "assistant"; text: string; action?: "goal" | "blocked" | "incidents" | "people" | "approvals" | "agent"; input?: string };
export function CommandFlow({ close, navigate, createGoal }: { close: () => void; navigate: (screen: Screen) => void; createGoal: (input: string) => void }) {
  const { state } = useStore();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { historyRef.current?.scrollIntoView({ block: "end" }); }, [messages]);
  function send(text = input) {
    const trimmed = text.trim(); if (!trimmed) return;
    const query = trimmed.toLowerCase();
    let answer: Message;
    if (/block|stuck/.test(query)) {
      const blocked = state.tasks.filter(t => t.status === "blocked");
      answer = { role: "assistant", text: blocked.length ? `${blocked.length} task(s) need intervention:\n${blocked.map(t => `${t.owner}: ${t.title}`).join("\n")}\nOpen the work queue to review dependencies and resolve blockers. Never paste credentials into this demo.` : "No work is currently blocked. The organization has what it needs.", action: "blocked" };
    } else if (/error|fail|incident|production/.test(query)) {
      const incidents = state.incidents.filter(i => i.status !== "resolved");
      answer = { role: "assistant", text: incidents.length ? `There are ${incidents.length} open incidents.\n${incidents.map(i => `${i.project}: ${i.title}. ${i.impact}`).join("\n")}\nI can show the evidence and a simulated recovery; I cannot inspect real logs or production.` : "All simulated incidents are resolved. No live monitoring service is connected.", action: "incidents" };
    } else if (/everyone|people|team|working/.test(query)) {
      answer = { role: "assistant", text: `${state.tasks.filter(t => t.status === "running").length} tasks are in progress.\n${state.workers.filter(w => w.status !== "idle").slice(0, 6).map(w => `${w.name} — ${state.tasks.find(t => t.id === w.taskId)?.title || w.role}`).join("\n")}`, action: "people" };
    } else if (/approval|approve|reject|payment/.test(query)) {
      answer = { role: "assistant", text: `${state.approvals.filter(a => a.status === "pending").length} decisions await your review. I will not approve authority, spending, or production changes through a text command. Review the evidence and make an explicit decision.`, action: "approvals" };
    } else if (/terminal|computer|inspect|run tests/.test(query)) {
      answer = { role: "assistant", text: "The computer-agent simulator can demonstrate inspection, tests, verification, and approval escalation. It has no access to your workstation. Open the supervised agent to run or pause the simulation.", action: "agent" };
    } else if (/get |prepare|launch|build|handle|create|goal|ready|upgrade/.test(query)) {
      answer = { role: "assistant", text: "I can prepare a template-based execution plan for this direction. You will review its tasks, suggested owners, dependencies, and approval gates before delegating. Nothing will execute externally.", action: "goal", input: trimmed };
    } else {
      answer = { role: "assistant", text: "This local prototype supports goal planning, blocked work, team summaries, incident review, approvals, and computer-agent simulation. Try ‘Show me everything blocked’ or ‘Get the Waves website ready for launch’. No request has been executed." };
    }
    setMessages(previous => [...previous, { role: "user", text: trimmed }, answer]); setInput("");
  }
  function act(message: Message) {
    if (message.action === "goal") { close(); createGoal(message.input || ""); return; }
    const screens: Record<string, Screen> = { blocked: "Work", incidents: "Systems", people: "People", approvals: "Approvals", agent: "AI" };
    if (message.action) { navigate(screens[message.action]); close(); }
  }
  return <Modal title="What do you want Waves to do?" eyebrow="WAVES AI / COMMAND" onClose={close} wide><div className="notice"><Sparkles size={15} /><span>Simulated assistant · Deterministic commands · No live model or external access</span></div>{messages.length ? <div className="chat-history" aria-live="polite">{messages.map((message, i) => <div className={`chat-message ${message.role}`} key={i}><span className="eyebrow">{message.role === "user" ? "YOU" : "WAVES AI"}</span><p>{message.text}</p>{message.action && <button className="button small" onClick={() => act(message)}>{message.action === "goal" ? "Prepare execution plan" : message.action === "agent" ? "Open computer agent" : `Review ${message.action === "blocked" ? "work" : message.action}`}<ArrowRight size={14} /></button>}</div>)}<div ref={historyRef} /></div> : <div className="command-suggestions">{["Show me everything blocked", "What is everyone working on?", "Find out why SEAI deployment failed", "Get the Waves website ready for launch"].map(text => <button className="suggestion" key={text} onClick={() => send(text)}><span>{text}</span><ArrowUpRight size={15} /></button>)}</div>}<form className="command-input" onSubmit={e => { e.preventDefault(); send(); }}><Terminal size={19} /><input autoFocus aria-label="Command" placeholder="Give direction, or ask a question…" value={input} onChange={e => setInput(e.target.value)} maxLength={500} /><button className="icon-button send-button" type="submit" disabled={!input.trim()} aria-label="Send command"><Send size={17} /></button></form><div className="input-help"><span>Important decisions always come back to you.</span><kbd>ESC to close</kbd></div></Modal>;
}
