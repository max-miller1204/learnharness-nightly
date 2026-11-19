// Spoken math for screen readers: MathJax's speech rule engine, English ClearSpeak.
// Its rules are bundled into the app (src/sre-system-external.js), so nothing loads
// from the network.
import type * as Sre from "speech-rule-engine/js/common/system.js";
import type { DrawnMath, LabelPiece } from "./choice-math";

let engine: typeof Sre | undefined;
let ready: Promise<void> | undefined;

/** Resolves once the engine can speak, and rejects when it can't run here. */
export function startSpeech(): Promise<void> {
  ready ??= (async () => {
    // Required here, not imported, so the engine and its rules load only once math is read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sre = require("speech-rule-engine/js/common/system.js") as typeof Sre;
    await sre.engineReady();
    // Readiness resets the domain to MathSpeak, so ClearSpeak is set last.
    await sre.setupEngine({ locale: "en", domain: "clearspeak", modality: "speech" });
    // The engine reports ready even when its rules failed to load, and then speaks nothing.
    if (!sre.toSpeech("<math><mi>x</mi></math>").trim()) throw new Error("The speech rules did not load");
    engine = sre;
  })();
  return ready;
}

/** True once startSpeech has resolved, so a newly shown row reads spoken math at once. */
export const speechReady = () => engine !== undefined;

const spoken = new Map<string, string>();

/** Speaks MathML. The engine catches its own errors and returns "" for math it can't speak. */
export function speak(mathml: string): string {
  if (!engine) throw new Error("Speech has not started");
  let said = spoken.get(mathml);
  if (said === undefined) {
    said = engine.toSpeech(mathml);
    if (spoken.size >= 500) spoken.clear();
    spoken.set(mathml, said);
  }
  return said;
}

/** One equation as a screen reader reads it: spoken by the engine when it can,
 * otherwise as symbol text ("P → Q"), so the math is never dropped. */
export function spokenMath(drawn: DrawnMath, speech: boolean, say: (mathml: string) => string = speak): string {
  if (speech) {
    try {
      const said = say(drawn.mathml).replace(/\s+/g, " ").trim();
      if (said) return said;
    } catch {
      // Falls back to the symbol text below.
    }
  }
  return drawn.symbols;
}

/** The label a screen reader reads: text as written, each equation through spokenMath. */
export function spokenLabel(pieces: LabelPiece[], speech: boolean, say?: (mathml: string) => string): string {
  return pieces.map((piece) => piece.kind === "text" ? piece.text : spokenMath(piece.drawn, speech, say))
    .join("").replace(/\s+/g, " ").trim();
}
