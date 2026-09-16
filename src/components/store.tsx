"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { initialState, reduce, parseSaved, type State, type Action } from "../lib/model";

const KEY = "waves-one-prototype-v1";
type Store = { state: State; dispatch: (action: Action) => void; ready: boolean; storageError: string; toast: string; notify: (message: string) => void };
const Context = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [toast, setToast] = useState("");
  useEffect(() => {
    let next = initialState;
    let warning = "";
    try {
      const raw = localStorage.getItem(KEY);
      const saved = parseSaved(raw);
      if (saved) next = saved;
      else if (raw) warning = "Saved demo data could not be read. A fresh demo was loaded.";
    } catch { warning = "Browser storage is unavailable. Changes will last only for this session."; }
    // Storage is external browser state; initialization must run after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
    setStorageError(warning);
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch { queueMicrotask(() => setStorageError("Changes could not be saved. Keep this tab open to retain your session.")); }
  }, [state, ready]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const dispatch = useCallback((action: Action) => setState(previous => reduce(previous, action)), []);
  const notify = useCallback((message: string) => setToast(message), []);
  return <Context.Provider value={{ state, dispatch, ready, storageError, toast, notify }}>{children}</Context.Provider>;
}
export function useStore() {
  const store = useContext(Context);
  if (!store) throw new Error("StoreProvider is required");
  return store;
}
