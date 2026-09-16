"use client";

import { useCallback, useEffect, useState } from "react";
import { Monitor, Play, ShieldCheck, Square, Terminal, WifiOff } from "lucide-react";
import { Badge, Empty, SectionTitle, StatusBadge, dateLabel } from "./ui";
import { CAPABILITY_RISK, jobCapability, type JobKind } from "../lib/agent-protocol";
import type { AgentJob, AuditRecord, ControlStatus, DeviceStatus } from "../lib/agent-client";
import { cancelJob, createApproval, createJob, getDevices, getStatus, listAudit, listJobs, pairDevice, resume, revokeDevice, stopAll } from "../lib/agent-client";

function truncateOutput(value: unknown, max = 500): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null || value === undefined) return "";
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? "";
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function jobRiskLabel(job: AgentJob): string {
  const capability = (() => {
    try {
      return jobCapability(job.kind as JobKind);
    } catch {
      return undefined;
    }
  })() || job.capability;
  if (capability && capability in CAPABILITY_RISK) return CAPABILITY_RISK[capability as keyof typeof CAPABILITY_RISK];
  return job.risk || "unknown";
}

export function DevicePanel() {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const loadStatusDevices = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([getStatus(), getDevices()]);
      setStatus(nextStatus);
      setDevices(nextDevices);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await listJobs(20));
    } catch {
      setUnreachable(true);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await listAudit(100));
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initial() {
      try {
        const [nextStatus, nextDevices, nextJobs, nextAudit] = await Promise.all([getStatus(), getDevices(), listJobs(20), listAudit(100)]);
        if (cancelled) return;
        setStatus(nextStatus);
        setDevices(nextDevices);
        setJobs(nextJobs);
        setAudit(nextAudit);
        setUnreachable(false);
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    }
    void initial();
    const timer = window.setInterval(() => { void loadStatusDevices(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [loadStatusDevices]);

  const hasActiveJobs = jobs.some(job => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(loadJobs, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, loadJobs]);

  useEffect(() => {
    const timer = window.setInterval(loadAudit, 5000);
    return () => window.clearInterval(timer);
  }, [loadAudit]);

  async function handlePair() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pairDevice(trimmed);
      setCode("");
      await loadStatusDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleInspect() {
    setBusy(true);
    setError(null);
    try {
      await createJob({ kind: "fs.list", params: { path: "." } });
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inspection failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleTestRun() {
    setBusy(true);
    setError(null);
    try {
      await createApproval({
        title: "Run project test suite",
        kind: "term.exec",
        params: { command: "npm test", cwd: "." },
        reason: "Verify the workspace before further work",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval request failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus({ ...(status || { paused: false, deviceCount: 0, onlineCount: 0, queuedJobs: 0 }), stopped: true });
      await stopAll(true);
      setConfirmStop(false);
      await loadStatusDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleResume() {
    setBusy(true);
    setError(null);
    try {
      await resume();
      await loadStatusDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(deviceId: string, machine: string) {
    if (typeof window !== "undefined" && !window.confirm(`Revoke access for ${machine || deviceId}? The workstation will be disconnected.`)) return;
    setError(null);
    try {
      await revokeDevice(deviceId);
      await loadStatusDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  async function handleCancel(jobId: string) {
    setError(null);
    try {
      await cancelJob(jobId);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  const onlineDevices = devices.filter(device => device.online);

  return <div className="stack">
    {unreachable && <div className="notice"><WifiOff size={18} /><span><strong>Control plane unreachable.</strong> Live device data will resume when the server is reachable. Demo content below is unaffected.</span></div>}
    <section className="panel">
      <SectionTitle title="CONNECTION" count={devices.length}><Badge tone={onlineDevices.length ? "success" : "neutral"}>{onlineDevices.length ? `${onlineDevices.length} online` : "No live device"}</Badge></SectionTitle>
      {devices.length === 0 ? <div className="stack">
        <p className="muted">No workstation paired. On the workstation, run <span className="mono">node agent/pair.mjs</span>, then <span className="mono">node agent/src/index.mjs</span>, and enter the 8-character code here.</p>
        <div className="toolbar">
          <label className="detail-field"><span className="muted">Pairing code</span><input aria-label="Pairing code" placeholder="8-character code" value={code} maxLength={8} onChange={event => setCode(event.target.value.toUpperCase())} /></label>
          <button className="button primary" disabled={!code.trim() || busy} onClick={handlePair}><Monitor size={15} />Pair</button>
        </div>
      </div> : <div className="list-panel">{devices.map(device => <article className="list-row" key={device.deviceId}>
        <Badge tone={device.online ? "success" : "neutral"}>{device.online ? "Online" : "Offline"}</Badge>
        <div className="row-main"><strong>{device.machine || device.deviceId}</strong><span className="muted">Agent {device.agentVersion || "unknown"} · Last heartbeat {device.lastHeartbeat ? dateLabel(device.lastHeartbeat) : "never"}</span>{device.currentJobId && <small className="muted">Current job <span className="mono">{device.currentJobId}</span></small>}</div>
        <button className="button small danger" onClick={() => handleRevoke(device.deviceId, device.machine)}>Revoke</button>
      </article>)}</div>}
    </section>
    {onlineDevices.length > 0 && <section className="panel">
      <SectionTitle title="LIVE CONTROLS"><Badge tone={status?.stopped ? "error" : "success"}>{status?.stopped ? "Stopped" : "Live"}</Badge></SectionTitle>
      <div className="toolbar">
        <button className="button" disabled={busy || status?.stopped} onClick={handleInspect}><Terminal size={15} />Run inspection</button>
        <button className="button" disabled={busy || status?.stopped} onClick={handleTestRun}><Play size={15} />Request test run</button>
        {status?.stopped
          ? <button className="button primary" disabled={busy} onClick={handleResume}><Play size={15} />Resume</button>
          : <button className="button danger" disabled={busy} onClick={handleStop}><Square size={15} />{confirmStop ? "Confirm STOP ALL" : "STOP ALL"}</button>}
      </div>
      {confirmStop && !status?.stopped && <p className="warning-text">Stop all execution and cancel queued jobs? Press STOP ALL again to confirm.</p>}
      {error && <p className="error-text">{error}</p>}
    </section>}
    {!onlineDevices.length && error && <p className="error-text">{error}</p>}
    <section>
      <SectionTitle title="JOBS" count={jobs.length}><span className="muted">Recent first</span></SectionTitle>
      {jobs.length ? <div className="table-wrap panel"><table className="data-table"><thead><tr><th scope="col">Kind</th><th scope="col">Risk</th><th scope="col">Status</th><th scope="col">Approval</th><th scope="col">Output</th><th scope="col"><span className="muted">Actions</span></th></tr></thead><tbody>{jobs.map(job => {
        const risk = jobRiskLabel(job);
        const result = (job.result ?? {}) as { output?: unknown; error?: unknown };
        const output = typeof result.error === "string" && result.error
          ? `Error: ${result.error}`
          : truncateOutput(result.output);
        return <tr key={job.id}><td><span className="mono">{job.kind}</span></td><td><Badge tone={risk === "high" ? "warning" : "neutral"}>{risk}</Badge></td><td><StatusBadge status={job.status} /></td><td>{job.approvalId ? <span className="mono">{job.approvalId}</span> : <span className="muted">—</span>}</td><td>{output ? <pre className="mono muted">{output}</pre> : <span className="muted">—</span>}</td><td>{(job.status === "queued" || job.status === "running") && <button className="button small" onClick={() => handleCancel(job.id)}>Cancel</button>}</td></tr>;
      })}</tbody></table></div> : <Empty title="No jobs yet">Run an inspection or approve a request to see live execution here.</Empty>}
    </section>
    <section>
      <SectionTitle title="AGENT AUDIT" count={audit.length}><span className="muted">Newest first</span></SectionTitle>
      <div className="agent-console" aria-label="Agent audit, newest first">{audit.map((event, index) => <div className="console-line" key={`${event.ts}-${event.action}-${index}`}>
        <time dateTime={event.ts} className="mono muted">{event.ts ? dateLabel(event.ts) : "—"}</time>
        <div className="row-main"><strong>{event.action}</strong><span>{event.target}{event.command ? ` · ${event.command}` : ""}</span><small className="muted">Permission: {event.permission}{event.approvalId ? ` · Approval ${event.approvalId}` : ""} · {event.error ? `Error: ${event.error}` : event.result}</small></div>
      </div>)}{!audit.length && <Empty title="No agent audit events">Live workstation actions will appear here with their authorization.</Empty>}</div>
    </section>
    <section className="panel">
      <SectionTitle title="AUTHORIZATION"><ShieldCheck size={18} /></SectionTitle>
      <p className="muted">Jobs execute on the authorized workstation sandbox only. Medium-risk actions need an approval; high-risk actions are never silent. Every action is recorded above with its permission and approval.</p>
    </section>
  </div>;
}
