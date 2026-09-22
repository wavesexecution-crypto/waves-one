"use client";

import { ArrowRight, Waves, Plus } from "lucide-react";
import { useStore } from "./store";
import { TextLink, timeLabel } from "./ui";
export type Selection = { type: "approval" | "goal" | "task" | "worker" | "incident" | "file" | "connector"; id: string };
export type Screen = "Overview" | "Goals" | "Work" | "People" | "Approvals" | "Activity" | "Systems" | "Files" | "AI" | "Settings";
export type ViewProps = { open: (selection: Selection) => void; navigate: (screen: Screen) => void; newGoal: () => void; command: () => void };

export function Overview({ open, navigate, newGoal, command }: ViewProps) {
  const { state } = useStore();
  const pending = state.approvals.filter(a => a.status === "pending");
  const incidents = state.incidents.filter(i => i.status !== "resolved");
  const blocked = state.tasks.filter(t => t.status === "blocked");
  const running = state.tasks.filter(t => t.status === "running");
  const completed = state.tasks.filter(t => t.status === "completed");
  const goals = state.goals.filter(g => g.status !== "completed");
  const attention = pending.length + incidents.length + blocked.length;
  const primaryAttention = pending[0] ?? incidents[0] ?? blocked[0] ?? null;

  return <>
    <div className="page-intro">
      <div>
        <p className="eyebrow">YOUR ORGANIZATION. IN FOCUS.</p>
        <h1>Good morning, Amey<span className="muted">.</span></h1>
        <p className="intro-copy">{attention ? `${attention} need your attention.` : "Nothing needs your attention — the system is clear."}</p>
      </div>
      <button className="button" onClick={newGoal} style={{ borderColor: 'var(--foreground)', color: 'var(--background)', background: 'var(--foreground)' }}><Plus size={14} /> New goal</button>
    </div>

    <div className="overview-layout">
      <div className="overview-main">
        {/* One dominant piece — the most urgent decision */}
        <section>
          <div className="section-heading">
            <h2>NEEDS YOU</h2>
            <span className="section-note">{attention} pending</span>
          </div>
          <div className="attention-stack">
            {primaryAttention ? (
              <article className="attention-card">
                <div className="attention-icon">—</div>
                <div className="attention-content">
                  <div className="card-eyebrow"><span>{(primaryAttention as unknown as Record<string, string>).project || 'Engineering'}</span><span className="badge warning">Requires decision</span></div>
                  <h3>{(primaryAttention as unknown as Record<string, string>).title || (primaryAttention as unknown as Record<string, string>).owner + ' needs a hand'}</h3>
                  <p style={{ maxWidth: 520 }}>{(primaryAttention as unknown as Record<string, string>).what || (primaryAttention as unknown as Record<string, string>).impact || (primaryAttention as unknown as Record<string, string>).title}</p>
                  <div className="card-foot">
                    <span>{(primaryAttention as unknown as Record<string, string>).requestedBy || (primaryAttention as unknown as Record<string, string>).project || 'WAVES'} · Ready</span>
                    <button className="button small" onClick={() => {
                      const a = pending[0]; if (a) open({ type: "approval", id: a.id }); else if (incidents[0]) open({ type: "incident", id: incidents[0].id }); else if (blocked[0]) open({ type: "task", id: blocked[0].id });
                    }}>Review <ArrowRight size={12} /></button>
                  </div>
                </div>
              </article>
            ) : (
              <div className="all-clear" style={{ border: '1px solid #141414', padding: 40, textAlign: 'left' }}>
                <h3 style={{ fontSize: 18, fontWeight: 380 }}>You’re all clear.</h3>
                <p style={{ fontSize: 12, color: 'var(--silver)', marginTop: 8 }}>The organization has what it needs. Set the next direction.</p>
              </div>
            )}
            {/* Secondary — hidden behind deliberate interaction */}
            {(pending.length > 1 || incidents.length > 0 || blocked.length > 0) && (
              <div style={{ marginTop: 24, borderTop: '1px solid #141414', paddingTop: 16, display: 'flex', gap: 16, fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: '#5a5a5a' }}>
                {pending.length > 1 && <button onClick={() => navigate("Approvals")} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>{pending.length - 1} more approvals</button>}
                {incidents.length > 0 && <button onClick={() => navigate("Systems")} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>{incidents.length} incidents</button>}
                {blocked.length > 0 && <button onClick={() => navigate("Work")} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>{blocked.length} blocked</button>}
              </div>
            )}
          </div>
        </section>

        {/* Subtle secondary — hairline list, not cards */}
        <section>
          <div className="section-heading"><h2>IN MOTION</h2><TextLink onClick={() => navigate("Work")}>All work</TextLink></div>
          <div className="list-panel" style={{ borderTop: '1px solid #141414' }}>
            {running.slice(0, 2).map(task => (
              <button className="motion-row" key={task.id} onClick={() => open({ type: "task", id: task.id })}>
                <span className="task-indicator"><span /></span>
                <div className="row-main"><strong>{task.title}</strong><span>{task.project} / {task.owner}</span></div>
                <span className="motion-state">Running</span>
              </button>
            ))}
            {running.length === 0 && <p className="panel-padding muted" style={{ padding: '16px 0', fontSize: 11, fontFamily: 'var(--font-geist-mono)' }}>No tasks running — delegate an active goal.</p>}
          </div>
        </section>

        <section>
          <div className="section-heading"><h2>ACTIVE GOALS</h2><TextLink onClick={() => navigate("Goals")}>All goals</TextLink></div>
          <div className="goal-grid">
            {goals.slice(0, 2).map(goal => {
              const tasks = state.tasks.filter(t => t.goalId === goal.id);
              const done = tasks.filter(t => t.status === "completed").length;
              const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
              return (
                <button className="goal-card" key={goal.id} onClick={() => open({ type: "goal", id: goal.id })}>
                  <div className="goal-top"><span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--silver)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>{goal.project}</span><span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--silver)' }}>{percent}%</span></div>
                  <h3>{goal.title}</h3>
                  <p>{tasks.length} tasks · {goal.deadline}</p>
                  <div style={{ marginTop: 16, height: 1, background: '#141414' }}><div style={{ width: `${percent}%`, height: 1, background: 'var(--foreground)' }} /></div>
                </button>
              );
            })}
            {goals.length === 0 && <p className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)' }}>No active goals.</p>}
          </div>
        </section>
      </div>

      <aside className="overview-rail">
        <section className="brief-panel">
          <div className="brief-heading"><span className="eyebrow">DAILY BRIEF</span><span className="mono" style={{ fontSize: 9, color: '#5a5a5a' }}>17 SEP</span></div>
          <h3>A clear view.<br /><span className="muted">A focused day.</span></h3>
          <div className="brief-stats">
            {[[completed.length, "Completed"], [running.length, "In progress"], [blocked.length, "Blocked"], [pending.length, "Needs approval"]].map(([number, label]) => (
              <div key={label}><strong>{String(number).padStart(2, "0")}</strong><span>{label}</span></div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid #141414', marginTop: 24, paddingTop: 16 }}>
            <button className="button" style={{ width: '100%', justifyContent: 'center' }} onClick={command}><Waves size={14} />Ask WAVES AI</button>
          </div>
        </section>

        <section>
          <div className="section-heading"><h2>LIVE ACTIVITY</h2><span className="live-label"><span className="status-dot success" />DEMO</span></div>
          <div className="timeline">
            {state.activity.slice(0, 3).map(event => (
              <button className="timeline-event" key={event.id} onClick={() => navigate("Activity")}>
                <span className={`timeline-dot ${event.severity}`} />
                <time>{timeLabel(event.timestamp)}</time>
                <p><strong>{event.actor}</strong> {event.action.charAt(0).toLowerCase() + event.action.slice(1)}.</p>
              </button>
            ))}
          </div>
        </section>
      </aside>
    </div>
  </>;
}
