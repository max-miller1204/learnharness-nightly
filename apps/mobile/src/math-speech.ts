// Spoken math for screen readers: MathJax's speech rule engine, English ClearSpeak,
// with its rules bundled into the app so nothing loads from the network.
import { engineReady, setupEngine, toSpeech } from "speech-rule-engine/js/common/system.js";
import type { LabelPiece } from "./choice-math";

const rules: Record<string, unknown> = {
  base: require("speech-rule-engine/lib/mathmaps/base.json"),
  en: require("speech-rule-engine/lib/mathmaps/en.json"),
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

/** Speaks MathML. Only call after startSpeech resolves. */
export function speak(mathml: string): string {
  return toSpeech(mathml);
}

/** The label a screen reader reads: text as written, math spoken, or as symbol text without the engine. */
export function spokenLabel(pieces: LabelPiece[], speech: boolean): string {
  return pieces.map((piece) => piece.kind === "text" ? piece.text : speech ? speak(piece.drawn.mathml) : piece.drawn.symbols)
    .join("").replace(/\s+/g, " ").trim();
}
