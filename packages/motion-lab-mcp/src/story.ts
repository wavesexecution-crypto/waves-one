/**
 * Story engine — transcript (or timed segments) into a validated story.
 *
 * A beat carries id, start/end, narration, intent, entities, emphasis,
 * intensity, and visual_intent. Everything here is deterministic for the
 * same input + configuration: keyword casting, proper-noun entities,
 * emphasis from explicit markers (caps, exclamations, repeated words).
 * Model interpretation is a first-class REPRESENTATION (the
 * interpretation field: "deterministic" vs "model:<id>"), never silent —
 * in Phase 2 all beats are deterministic; agent sessions may attach
 * model-authored beats explicitly via withModelInterpretation().
 */

export interface StoryBeatInput {
  startMs: number;
  endMs?: number;
  text?: string;
}

export interface StoryBeat {
  id: string;
  startMs: number;
  endMs: number;
  narration: string;
  intent: string;
  label: string;
  entities: string[];
  emphasis: string[];
  intensity: number;
  visualIntent: string;
}

export interface Story {
  beats: StoryBeat[];
  interpretation: string;
  durationMs: number;
}

const INTENT_PATTERNS: Array<{ match: RegExp; intent: string; visual: string }> = [
  // Explicit visual nouns win over thematic guesses: saying "network" means
  // the network visual even when CRM words share the sentence.
  { match: /\bnetwork\b|\bgraph\b|connect/, intent: "discovery", visual: "network" },
  { match: /problem|pain|struggl|hard|manual|chaos|drown/, intent: "problem", visual: "title" },
  // The one system: convergence into the WAVES identity (orb), never a dashboard.
  { match: /\bsystem\b|platform|transform|become|converge|unif|together/, intent: "system", visual: "orb" },
  { match: /\bcrm\b|customers?|leads?|prospects?|contacts?|clients?|buyers?|accounts?/, intent: "prospects", visual: "crm" },
  // Scattered sources that have not converged yet: many origins, network visual.
  { match: /\bsources?|scattered|everywhere|inbox|emails?|messages?|notifications?/, intent: "discovery", visual: "network" },
  { match: /find|search|seek|discover|hunt|look for|brows|lookup/, intent: "discovery", visual: "network" },
  { match: /notebook|research|context|understand|insight|analy[sz]|plan|strategy|blueprint|\bknow|learn|remember/, intent: "insight", visual: "notebook" },
  { match: /workflow|outreach|deploy|execut|action|follow|pipeline|process|automat|manual|repetitive|hours|steps?|agents?|move|forward|progress|\brun/, intent: "action", visual: "workflow" },
  { match: /report|result|milestone|track|measur|outcome|growth|scale|numbers?/, intent: "report", visual: "milestones" },
  { match: /finale|conclus|thank|choose|rent|operate|done\b|complete/, intent: "finale", visual: "title" },
  { match: /\borb\b|waves\b|intelligence\b/, intent: "establish", visual: "orb" }
];

const ENTITY_STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,than,so,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,it,its,this,that,these,those,you,your,we,our,they,their,he,she,his,her,will,can,just,not,no,do,does,into,out,up,more,most,what,when,how,why,all,any,there,here,i,me,my".split(",")
);

/** Capitalized terms + known product nouns, for procedural scene data. Exported for planners. */
export function extractEntities(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9&'-]*)\b/g)) {
    const word = match[1];
    if (word.length < 3 || ENTITY_STOPWORDS.has(word.toLowerCase()) || seen.has(word)) continue;
    seen.add(word);
    found.push(word);
    if (found.length >= 8) break;
  }
  for (const candidate of ["CRM", "orb", "WAVES", "notebook", "workflow", "report"]) {
    if (text.toLowerCase().includes(candidate.toLowerCase()) && !seen.has(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
  }
  return found;
}

function extractEmphasis(text: string): { markers: string[]; intensity: number } {
  const markers: string[] = [];
  if (/!/.test(text)) markers.push("exclamation");
  const caps = text.match(/\b[A-Z]{3,}\b/g) ?? [];
  for (const word of caps.slice(0, 4)) markers.push(`caps:${word}`);
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.length < 4 || ENTITY_STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const [word, count] of counts) {
    if (count >= 3 && markers.length < 6) markers.push(`repeated:${word}`);
  }
  const intensity = Math.max(0, Math.min(1, 0.35 + markers.length * 0.15 + Math.min(0.2, text.length / 500)));
  return { markers, intensity: Math.round(intensity * 100) / 100 };
}

const INTENT_LABELS: Record<string, string> = {
  establish: "INTRO",
  problem: "PROBLEM",
  prospects: "CRM",
  discovery: "DISCOVERY",
  insight: "NOTEBOOK",
  action: "WORKFLOW",
  report: "REPORT",
  finale: "FINALE",
  system: "SYSTEM",
  beat: "BEAT"
};
function castVisual(text: string): string {
  const lowered = text.toLowerCase();
  const found = INTENT_PATTERNS.find((candidate) => candidate.match.test(lowered));
  return found ? found.visual : "title";
}

function castLabel(text: string): string {
  const intent = castIntent(text);
  return INTENT_LABELS[intent] ?? "BEAT";
}

function castIntent(text: string): string {
  const lowered = text.toLowerCase();
  const found = INTENT_PATTERNS.find((candidate) => candidate.match.test(lowered));
  return found ? found.intent : "beat";
}

/**
 * Split narration into sentences (shared by transcript and segment alignment).
 */
export function splitSentences(transcript: string): string[] {
  return transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim().replace(/[.?!;]+$/, ""))
    .filter((part) => part.length > 0)
    .slice(0, 12);
}

/**
 * Align transcript sentences onto timed segments that carry no text (energy
 * beats). Sentences spread evenly across the duration (the same layout as
 * the transcript-only path); each segment takes the sentences overlapping
 * its window, so no narration is dropped and no beat is left empty while
 * sentences remain. Deterministic.
 */
export function alignTranscriptToSegments(
  transcript: string,
  segments: Array<{ startMs: number; endMs: number }>,
  totalMs: number
): string[] {
  const sentences = splitSentences(transcript);
  if (sentences.length === 0) return segments.map(() => "");
  const total = Math.max(1, totalMs);
  const windows = sentences.map((text, index) => ({
    text,
    start: Math.floor((total * index) / sentences.length),
    end: Math.floor((total * (index + 1)) / sentences.length)
  }));
  return segments.map((segment) => {
    const start = Math.max(0, segment.startMs);
    const end = Math.max(start, segment.endMs);
    return windows
      .filter((window) => window.start < end && start < window.end)
      .map((window) => window.text)
      .join(" ");
  });
}
/**
 * Build a story from transcript text and/or timed segments. Segment times
 * win when present; otherwise sentences spread evenly across durationMs.
 * Segments without text inherit transcript sentences aligned to their
 * windows, so keyless energy beats keep narration semantics.
 */
export function buildStory(
  transcript: string,
  durationMs: number,
  segments?: Array<{ startMs: number; endMs?: number; text?: string }>
): Story {
  const total = Math.max(3000, Math.min(120000, Math.round(durationMs) || 20000));
  const timed =
    Array.isArray(segments) && segments.length > 0
      ? segments.map((segment) => ({
          startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
          endMs: Math.round(Number(segment.endMs) || 0),
          text: typeof segment.text === "string" ? segment.text : ""
        }))
      : [];
  const aligned =
    timed.length > 0 && timed.every((segment) => !segment.text.trim()) && transcript.trim()
      ? alignTranscriptToSegments(transcript, timed, total)
      : null;
  const inputs: Array<{ startMs: number; endMs: number; text: string }> =
    timed.length > 0
      ? timed.map((segment, index) => ({ ...segment, text: aligned ? (aligned[index] ?? "") : segment.text }))
      : splitSentences(transcript).map((text, index, all) => ({
          startMs: Math.floor((total * index) / all.length),
          endMs: Math.floor((total * (index + 1)) / all.length),
          text
        }));
  if (inputs.length === 0) throw new Error("buildStory needs transcript text or non-empty segments.");
  const beats = inputs.map((input, index) => {
    const endMs = input.endMs > input.startMs ? Math.min(total, input.endMs) : index + 1 < inputs.length ? inputs[index + 1].startMs : total;
    const { markers, intensity } = extractEmphasis(input.text);
    return {
      id: `beat-${String(index + 1).padStart(2, "0")}`,
      startMs: input.startMs,
      endMs: Math.max(input.startMs + 500, endMs),
      narration: input.text,
      intent: castIntent(input.text),
      label: castLabel(input.text),
      entities: extractEntities(input.text),
      emphasis: markers,
      intensity,
      visualIntent: castVisual(input.text)
    };
  });
  return { beats, interpretation: "deterministic", durationMs: total };
}

/** Attach explicit model interpretation (agent-authored, never silent). */
export function withModelInterpretation(story: Story, provider: string, model: string, note: string): Story {
  return { ...story, interpretation: `model:${provider}/${model}:${note}` };
}

/** Structural validation: ordered, non-overlapping, within duration. */
export function validateStory(story: Story): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(story.beats) || story.beats.length === 0) {
    return { ok: false, errors: ["Story has no beats."] };
  }
  story.beats.forEach((beat, index) => {
    if (typeof beat.startMs !== "number" || typeof beat.endMs !== "number" || !(beat.endMs > beat.startMs)) {
      errors.push(`Beat ${beat.id ?? index} has a non-positive span.`);
    }
    if (beat.startMs < 0 || beat.endMs > story.durationMs) {
      errors.push(`Beat ${beat.id ?? index} escapes the story duration.`);
    }
    if (index > 0 && beat.startMs < story.beats[index - 1].endMs) {
      errors.push(`Beat ${beat.id ?? index} overlaps beat ${story.beats[index - 1].id}.`);
    }
    if (!beat.id || !beat.intent || !beat.visualIntent) {
      errors.push(`Beat at index ${index} is missing id, intent, or visual intent.`);
    }
  });
  return { ok: errors.length === 0, errors };
}
