import { createEngine } from "@waves/motion";

export type LabEngine = ReturnType<typeof createEngine>;

let labEngine: LabEngine | null = null;

/** Shared lab engine (RAF clock in the browser, isolated from tests). */
export function getLabEngine(): LabEngine {
  if (!labEngine) {
    labEngine = createEngine({ name: "lab" });
  }
  return labEngine;
}

/**
 * Renew the lab engine: dispose the old instance (stops its pump, drops
 * tickables/listeners/diagnostics) and create a fresh one. Every replay
 * starts from a zero clock with no stale state — this is what makes
 * replay-from-t=0 deterministic regardless of playback history.
 */
export function renewLabEngine(): LabEngine {
  if (labEngine) {
    try {
      labEngine.dispose();
    } catch {
      /* already disposed */
    }
    labEngine = null;
  }
  return getLabEngine();
}

/** Copy text to the clipboard with a textarea fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

/** Clear inline motion styles under a root (lab reset helper). */
export function clearMotionStyles(root: ParentNode = document): void {
  const targets = root.querySelectorAll<HTMLElement>("[data-lab]");
  targets.forEach((element) => {
    element.style.transform = "";
    element.style.opacity = "";
    element.style.filter = "";
  });
}

/** Reset the lab engine (cancels everything, clears diagnostics). */
export function resetLabEngine(): void {
  getLabEngine().reset();
  clearMotionStyles(document);
}
