"use client";

import { useEffect, useRef, useId, type ReactNode } from "react";
import { X, ArrowUpRight, Waves } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><Waves size={25} strokeWidth={2.2} /><span>WAVES <b>ONE</b></span>{!compact && <span className="brand-mark">HQ</span>}</div>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}><span className="dot" />{children}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  const tone = ["completed", "active", "approved", "allowed", "resolved"].includes(status) ? "success" : ["blocked", "review", "pending", "approval", "changes-requested"].includes(status) ? "warning" : ["error", "rejected", "denied"].includes(status) ? "error" : ["running", "investigating"].includes(status) ? "info" : "neutral";
  return <Badge tone={tone}>{status.replaceAll("-", " ")}</Badge>;
}
export function SectionTitle({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return <div className="section-heading"><h2>{title}{count !== undefined && <span className="count">{count.toString().padStart(2, "0")}</span>}</h2><div>{children}</div></div>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-symbol">✓</div><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
export function Avatar({ initials, agent = false }: { initials: string; agent?: boolean }) {
  return <span className={`avatar ${agent ? "agent-avatar" : ""}`}>{agent ? <Waves size={17} /> : initials}</span>;
}
export function Progress({ value }: { value: number }) {
  return <div className="progress" role="progressbar" aria-label="Goal progress" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${value}%` }} /></div>;
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={14} /></button>;
}
export function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleCancel = (event: Event) => { event.preventDefault(); closeRef.current(); };
    dialog?.addEventListener("cancel", handleCancel);
    return () => {
      dialog?.removeEventListener("cancel", handleCancel);
      dialog?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? "wide" : ""}`} aria-labelledby={titleId} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}><div className="modal-head"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div><div className="modal-body">{children}</div></dialog>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-field"><h3>{label}</h3><div>{children}</div></div>;
}
export function timeLabel(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
export function dateLabel(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
