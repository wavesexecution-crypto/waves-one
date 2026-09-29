/**
 * Target-website code generation — the snippet the AI pastes (or writes)
 * into the real project. Framework-agnostic vanilla JS against the public
 * @waves/motion API. The browser preview and this code describe the same
 * ops, so preview-then-ship stays faithful.
 */

import type { MotionOp } from "./ops.js";

function springLines(spring: { stiffness?: number; damping?: number; mass?: number } | undefined, indent: string): string {
  if (!spring) return "";
  const parts: string[] = [];
  if (spring.stiffness !== undefined) parts.push(`stiffness: ${spring.stiffness}`);
  if (spring.damping !== undefined) parts.push(`damping: ${spring.damping}`);
  if (spring.mass !== undefined) parts.push(`mass: ${spring.mass}`);
  if (parts.length === 0) return "";
  return `,\n${indent}spring: { ${parts.join(", ")} }`;
}

function optionsLiteral(op: Extract<MotionOp, { kind: "animate" }>): string {
  const options = op.options ?? {};
  const lines: string[] = [];
  if (options.duration !== undefined) lines.push(`duration: ${options.duration}`);
  if (options.delay !== undefined) lines.push(`delay: ${options.delay}`);
  if (options.easing !== undefined) lines.push(`easing: "${options.easing}"`);
  if (options.stagger !== undefined) lines.push(`stagger: ${options.stagger}`);
  if (options.staggerFrom !== undefined) lines.push(`staggerFrom: "${options.staggerFrom}"`);
  if (options.repeat !== undefined) lines.push(`repeat: ${options.repeat}`);
  if (options.yoyo !== undefined) lines.push(`yoyo: ${options.yoyo}`);
  let body = lines.length > 0 ? `{\n    ${lines.join(",\n    ")}` : `{`;
  if (options.spring) body += springLines(options.spring, "    ");
  body += lines.length > 0 || options.spring ? `\n  }` : `}`;
  return body;
}

export function codeForOp(op: MotionOp): string {
  const header = `import { createEngine } from "@waves/motion";\n\nconst engine = createEngine({ name: "site" });\n`;
  switch (op.kind) {
    case "reset":
      return `${header}engine.reset();`;
    case "scene":
      return (
        `// Lab preview scene only — no engine code needed.\n` +
        `// Targets materialize as: ${op.scene.elements.map((element) => `#lab-scene-${element.key}`).join(", ")}`
      );
    case "animate":
      return (
        `${header}engine.animate(${JSON.stringify(op.target)}, ${JSON.stringify(op.properties)}, ` +
        `${optionsLiteral(op)});`
      );
    case "preset": {
      const params = op.params && Object.keys(op.params).length > 0 ? `, ${JSON.stringify(op.params)}` : `, {}`;
      const options = op.options ? `, ${JSON.stringify(op.options)}` : ``;
      return (
        `import { createEngine } from "@waves/motion";\n` +
        `import { runPreset } from "@waves/motion";\n\n` +
        `const engine = createEngine({ name: "site" });\n` +
        `runPreset(${JSON.stringify(op.preset)}, ${JSON.stringify(op.target)}${params}, engine${options});`
      );
    }
    case "timeline": {
      const nodes = op.nodes
        .map((node) => {
          const body = node.preset
            ? `runPresetSpec(${JSON.stringify(node.preset)}, ${JSON.stringify(node.target)}, ${JSON.stringify(node.params ?? {})})`
            : `motion({ target: ${JSON.stringify(node.target)}, properties: ${JSON.stringify(node.properties ?? {})}${
                node.label ? `, label: ${JSON.stringify(node.label)}` : ``
              } })`;
          const tweaks: string[] = [];
          if (node.at !== undefined) tweaks.push(`.at(${node.at})`);
          if (node.after !== undefined) tweaks.push(`.after(${JSON.stringify(node.after)})`);
          return `tl.add(${body}${tweaks.join("")});`;
        })
        .join("\n");
      return (
        `import { createEngine } from "@waves/motion";\n` +
        `import { createTimeline, motion${op.nodes.some((node) => node.preset) ? `, runPresetSpec` : ``} } from "@waves/motion";\n\n` +
        `const engine = createEngine({ name: "site" });\n` +
        `const tl = createTimeline(engine${op.label ? `, { label: ${JSON.stringify(op.label)} }` : ``});\n` +
        `${nodes}\n` +
        `tl.play();`
      );
    }
    case "scroll":
      return (
        `${header}import { createScroll } from "@waves/motion";\n\n` +
        `createScroll(engine, ${JSON.stringify(op.target)}, ${JSON.stringify(op.properties ?? { y: [40, 0], opacity: [0.2, 1] })}, ` +
        `${JSON.stringify(op.options ?? { start: "enter", end: "end", easing: "waves-smooth" })}).play();`
      );
    case "text":
      return (
        `${header}// Split the headline into per-char spans, then stagger through core.\n` +
        `const chars = document.querySelectorAll(${JSON.stringify(`${op.target} .char`)});\n` +
        `engine.animate(chars, { y: [12, 0], opacity: [0, 1] }, {\n` +
        `  duration: ${op.duration ?? 350},\n` +
        `  easing: ${JSON.stringify(op.easing ?? "waves-entrance")},\n` +
        `  stagger: ${op.stagger ?? 40},\n` +
        `  staggerFrom: "first"\n` +
        `});`
      );
  }
}
