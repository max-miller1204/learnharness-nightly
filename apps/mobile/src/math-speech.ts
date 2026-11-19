// Spoken math for screen readers: MathJax's speech rule engine, English ClearSpeak,
// with its rules bundled into the app so nothing loads from the network.
import { engineReady, setupEngine, toSpeech } from "speech-rule-engine/js/common/system.js";
import type { DrawnMath, LabelPiece } from "./choice-math";

// Metro hands back the parsed JSON; Node's ESM loader wraps it as { default }.
const json = (mod: { default?: unknown }) => mod.default ?? mod;
const rules: Record<string, unknown> = {
  base: json(require("speech-rule-engine/lib/mathmaps/base.json")),
  en: json(require("speech-rule-engine/lib/mathmaps/en.json")),
};

let ready: Promise<void> | undefined;

/** Resolves once the engine can speak, and rejects when it can't run here. */
export function startSpeech(): Promise<void> {
  ready ??= (async () => {
    await setupEngine({
      locale: "en",
      domain: "clearspeak",
      modality: "speech",
      // The engine parses either a JSON string or the parsed maps.
      custom: (locale: string) => rules[locale] ? Promise.resolve(rules[locale]) : Promise.reject(new Error(`No ${locale} rules`)),
    } as unknown as Parameters<typeof setupEngine>[0]); // its types allow only strings for `custom`
    await engineReady();
  })();
  return ready;
}

/** Speaks MathML. Only call after startSpeech resolves. The engine catches its own
 * errors and returns "" for math it can't speak. */
export function speak(mathml: string): string {
  return toSpeech(mathml);
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
