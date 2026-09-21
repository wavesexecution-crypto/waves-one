"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Bot, CircleCheck, FolderOpen, LayoutGrid, ListChecks, MoreHorizontal, Plus, Settings, ShieldCheck, Target, Terminal, TriangleAlert, Users } from "lucide-react";
import { StoreProvider, useStore } from "./store";
import { Brand, Modal } from "./ui";
import { getStatus, resume, stopAll } from "../lib/agent-client";
import { Overview, type Screen, type Selection } from "./overview";
import { Workspace } from "./workspace";
import { CommandFlow, DetailFlow, GoalFlow } from "./flows";

const NAV: { screen: Screen; icon: typeof Target; primary?: boolean }[] = [
  { screen: "Overview", icon: LayoutGrid, primary: true },
  { screen: "Goals", icon: Target },
  { screen: "Work", icon: ListChecks, primary: true },
  { screen: "People", icon: Users },
  { screen: "Approvals", icon: ShieldCheck, primary: true },
  { screen: "Activity", icon: Activity, primary: true },
  { screen: "Systems", icon: TriangleAlert },
  { screen: "Files", icon: FolderOpen, },
  { screen: "AI", icon: Bot },
  { screen: "Settings", icon: Settings },
];

const MORE_SCREENS: Screen[] = ["Goals", "People", "Systems", "Files", "AI", "Settings"];

function TopStopControl() {
  const [snapshot, setSnapshot] = useState<{ stopped: boolean; runningJobs: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const next = await getStatus();
        if (cancelled) return;
        setSnapshot({ stopped: next.stopped, runningJobs: next.runningJobs });
        if (next.runningJobs === 0) setArmed(false);
      } catch {
        /* fail-silent: control plane unreachable */
      }
    }
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  async function refresh() {
    try {
      const next = await getStatus();
      setSnapshot({ stopped: next.stopped, runningJobs: next.runningJobs });
      if (next.runningJobs === 0) setArmed(false);
    } catch {
      /* fail-silent */
    }
  }

  async function handleStop() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await stopAll(true);
      setArmed(false);
      await refresh();
    } catch {
      /* fail-silent */
    } finally {
      setBusy(false);
    }
  }

  async function handleResume() {
    setBusy(true);
    try {
      await resume();
      await refresh();
    } catch {
      /* fail-silent */
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) return null;
  if (snapshot.stopped) return <button className="button small" disabled={busy} onClick={handleResume}>Resume</button>;
  if (snapshot.runningJobs > 0) return <button className="button small danger" disabled={busy} onClick={handleStop}>{armed ? "Confirm STOP" : `STOP ${snapshot.runningJobs}`}</button>;
  return null;
}

function Headquarters() {
  const { state, dispatch, ready, storageError, toast, notify } = useStore();
  const [entered, setEntered] = useState(false);
  const [screen, setScreen] = useState<Screen>("Overview");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [goalFlow, setGoalFlow] = useState<{ open: boolean; initial: string }>({ open: false, initial: "" });
  const [command, setCommand] = useState(false);
  const [more, setMore] = useState(false);
  const [reset, setReset] = useState(false);
  useEffect(() => {
    if (!ready) return;
    try { if (localStorage.getItem("waves-one-entered") === "1") queueMicrotask(() => setEntered(true)); } catch { /* entry state is cosmetic */ }
  }, [ready]);
  const enter = useCallback(() => {
    setEntered(true);
    try { localStorage.setItem("waves-one-entered", "1"); } catch { /* session-only entry */ }
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (document.querySelector("dialog[open]")) return;
        setCommand(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const navigate = useCallback((next: Screen) => { setScreen(next); setMore(false); window.scrollTo({ top: 0 }); }, []);
  const open = useCallback((next: Selection) => setSelection(next), []);
  const newGoal = useCallback((initial = "") => setGoalFlow({ open: true, initial }), []);
  const pending = state.approvals.filter(a => a.status === "pending").length;
  const incidents = state.incidents.filter(i => i.status !== "resolved").length;
  if (!ready) return <div className="entry-screen"><Brand compact /><p className="muted">Preparing your headquartersâ€¦</p></div>;
  if (!entered) return <div className="entry-screen">
    <Brand />
    <h1>The operating headquarters<br />of Waves.</h1>
    <p className="entry-copy">You give direction. WAVES executes. This is a local, interactive prototype: decisions, delegation, and agent supervision are simulated in your browser. No external systems are connected, and no credentials are requested.</p>
    <button className="button primary large" onClick={enter}>Enter WAVES ONE<CircleCheck size={17} /></button>
    <div className="entry-facts"><div><span className="eyebrow">RUNS</span><span>Entirely in this browser</span></div><div><span className="eyebrow">CONNECTS</span><span>Nothing external yet</span></div><div><span className="eyebrow">DECIDES</span><span>Only you, always</span></div></div>
    <p className="entry-foot">OBSIDIAN design language Â· Demonstration build</p>
  </div>;
  return <div className="shell">
    <header className="top-bar">
      <button className="brand-button" onClick={() => navigate("Overview")} aria-label="Go to overview"><Brand compact /></button>
      <div className="top-actions">
        <TopStopControl />
        <button className="icon-button bordered" aria-label="Open WAVES AI command" onClick={() => setCommand(true)}><Terminal size={18} /></button>
        <button className="button primary small" onClick={() => newGoal()}><Plus size={15} /> New goal</button>
      </div>
    </header>
    <div className="shell-body">
      <nav className="sidebar" aria-label="Primary">
        {NAV.map(item => <button key={item.screen} className={`nav-item ${screen === item.screen ? "active" : ""}`} onClick={() => navigate(item.screen)} aria-current={screen === item.screen ? "page" : undefined}>{<item.icon size={18} />}<span>{item.screen}</span>{item.screen === "Approvals" && pending > 0 && <span className="nav-count">{pending}</span>}{item.screen === "Systems" && incidents > 0 && <span className="nav-count alert">{incidents}</span>}</button>)}
        <div className="sidebar-foot"><button className="agent-summary" onClick={() => navigate("AI")}><span className="agent-summary-icon"><Terminal size={18} /></span><div><strong>Computer agent</strong><span>{state.agentPaused ? "Paused" : "Supervised"}</span></div></button></div>
      </nav>
      <main className="content" id="main">
        {screen === "Overview" ? <Overview open={open} navigate={navigate} newGoal={() => newGoal()} command={() => setCommand(true)} /> : <Workspace screen={screen} open={open} navigate={navigate} newGoal={() => newGoal()} command={() => setCommand(true)} />}
        <footer className="content-footer">WAVES ONE Â· Local prototype Â· Decisions affect demo state only</footer>
      </main>
    </div>
    <nav className="bottom-nav" aria-label="Primary mobile">
      {NAV.filter(item => ["Overview", "Approvals", "Activity"].includes(item.screen)).map(item => <button key={item.screen} className={screen === item.screen ? "active" : ""} onClick={() => navigate(item.screen)} aria-current={screen === item.screen ? "page" : undefined}>{<item.icon size={18} />}<span>{item.screen === "Overview" ? "Home" : item.screen}</span>{item.screen === "Approvals" && pending > 0 && <span className="nav-count">{pending}</span>}</button>)}
      <button className={MORE_SCREENS.includes(screen) ? "active" : ""} onClick={() => setMore(true)}><MoreHorizontal size={18} /><span>More</span></button>
    </nav>
    {more && <Modal title="More" eyebrow="NAVIGATE" onClose={() => setMore(false)}>
      <div className="more-grid">{NAV.filter(item => !item.primary && item.screen !== "Overview").map(item => <button className="more-item" key={item.screen} onClick={() => { navigate(item.screen); setMore(false); }}>{<item.icon size={20} />}<span>{item.screen}</span>{item.screen === "Approvals" && pending > 0 && <span className="nav-count">{pending}</span>}{item.screen === "Systems" && incidents > 0 && <span className="nav-count alert">{incidents}</span>}</button>)}</div>
    </Modal>}
    {selection && <DetailFlow key={`${selection.type}-${selection.id}`} selection={selection} close={() => setSelection(null)} open={open} />}
    {goalFlow.open && <GoalFlow initial={goalFlow.initial} close={() => setGoalFlow({ open: false, initial: "" })} onCreated={id => { setGoalFlow({ open: false, initial: "" }); setSelection({ type: "goal", id }); }} />}
    {command && <CommandFlow close={() => setCommand(false)} navigate={navigate} createGoal={initial => { setCommand(false); newGoal(initial); }} />}
    {toast && <div className="toast" role="status"><CircleCheck size={17} />{toast}</div>}
    {storageError && <div className="storage-notice" role="alert"><TriangleAlert size={16} /><span>{storageError}</span><button className="text-link" onClick={() => { try { localStorage.removeItem("waves-one-prototype-v1"); } catch { /* nothing to clear */ } window.location.reload(); }}>Reload fresh</button></div>}
    <button className="reset-chip" onClick={() => setReset(true)}>Reset demo</button>
    {reset && <Modal title="Reset this demo?" eyebrow="SETTINGS" onClose={() => setReset(false)}><p>All goals, decisions, tasks, and audit events you created in this browser will be restored to the original demonstration state. Nothing outside this browser is affected.</p><div className="modal-actions"><button className="button" onClick={() => setReset(false)}>Keep my demo</button><button className="button danger" onClick={() => { dispatch({ type: "RESET" }); try { localStorage.removeItem("waves-one-entered"); } catch { /* cosmetic */ } setReset(false); setSelection(null); navigate("Overview"); notify("Demo restored to its original state."); }}>Reset demo</button></div></Modal>}
  </div>;
}

export default function Home() {
  return <StoreProvider><Headquarters /></StoreProvider>;
}

