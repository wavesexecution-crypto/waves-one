import { useEffect } from "react";
import GsapLab from "./GsapLab";
import "./gsap-lab.css";
import "./brand-film.css";

/**
 * WAVES Motion Lab — the GSAP workspace.
 *
 * The Lab is now single-surface: the brand film and any other published GSAP
 * scene play here through the Motion Spec system and GsapEngine. The previous
 * LAB and AI MOTION views have been retired from this app; the Cosmos3-Nano
 * provider and the AI Motion MCP surface are untouched and still live in
 * `packages/motion-lab-mcp`.
 *
 * `?capture=1` is the frame the video exporter records: the stage only, edge to
 * edge, no chrome, so a rendered film is exactly what the viewer saw.
 */
export default function App() {
  useEffect(() => {
    const capture = new URLSearchParams(window.location.search).has("capture");
    document.documentElement.classList.toggle("bf-capture", capture);
    if (!capture) return;
    return () => document.documentElement.classList.remove("bf-capture");
  }, []);

  return <GsapLab />;
}

