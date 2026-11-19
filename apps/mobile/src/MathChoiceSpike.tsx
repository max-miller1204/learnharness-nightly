// First-task spike for docs/specs/mobile-quiz-choice-math.md, shown in place of the
// app when EXPO_PUBLIC_MATH_SPIKE=1. It is removed once the feature is built.
import { useEffect, useMemo, useState } from "react";
import { LogBox, Pressable, ScrollView, Text, View } from "react-native";
import { splitLabel, type LabelPiece } from "./choice-math";
import { speak, spokenLabel, startSpeech } from "./math-speech";
import { MathLabel } from "./MathLabel";
import { radius, space, useTheme } from "./theme";

const MATH_LABEL = "No, $P\\to Q$ is blocked.";
const PLAIN_LABEL = "Yes, it holds.";

// A LogBox banner would be one more TalkBack stop over the rows; logcat still gets every line.
LogBox.ignoreAllLogs(true);

const engine = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === "object" ? "Hermes" : "not Hermes";

export function MathChoiceSpike() {
  const { s } = useTheme();
  const [speech, setSpeech] = useState<"loading" | "ready" | string>("loading");
  const [selected, setSelected] = useState<number>();
  const drawn = useMemo(() => {
    try { return { pieces: [splitLabel(MATH_LABEL), splitLabel(PLAIN_LABEL)] }; }
    catch (error) { return { error: String((error as Error)?.stack ?? error) }; }
  }, []);
  useEffect(() => {
    startSpeech().then(() => setSpeech("ready"), (error: unknown) => setSpeech(`failed: ${String((error as Error)?.stack ?? error)}`));
  }, []);
  const ready = speech === "ready";
  const labels = drawn.pieces?.map((pieces) => spokenLabel(pieces, ready));
  const mathDrawn = drawn.pieces?.[0]?.some((piece) => piece.kind === "math") ?? false;
  const math = drawn.pieces?.[0]?.find((piece) => piece.kind === "math");
  const rawSpeech = useMemo(() => ready && math ? diagnoseSpeech(math.drawn.mathml) : "not run", [ready, math]);
  const status = [
    `Engine: ${engine}`,
    `MathJax: ${drawn.error ? `failed: ${drawn.error}` : mathDrawn ? "drew the math" : "did not find math"}`,
    `Speech engine: ${speech}`,
    `Raw speech for the math: ${rawSpeech}`,
    `Row 1 spoken label: ${labels?.[0] ?? "none"}`,
    `Selected: ${selected === undefined ? "none" : `row ${selected + 1}`}`,
  ];
  useEffect(() => { console.log(`[MathSpike] ${status.join(" | ")}`); });
  // Each row's final accessibilityLabel, for matching against TalkBack's spoken output.
  const labelLog = labels?.map((label, index) => `[MathSpike] row ${index + 1} accessibilityLabel=${JSON.stringify(label)} role=radio checked=${selected === index}`).join("\n");
  useEffect(() => { if (labelLog) console.log(labelLog); }, [labelLog]);
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Text accessibilityRole="header" style={s.title}>Math choice spike</Text>
      {status.map((line) => <Text key={line.slice(0, 12)} style={s.ui}>{line}</Text>)}
      <Text style={s.prose}>Which is true?</Text>
      <View accessibilityRole="radiogroup" style={{ gap: space.sm }}>
        {drawn.pieces?.map((pieces, index) => (
          <ChoiceRow key={index} pieces={pieces} label={labels?.[index] ?? ""} selected={selected === index}
            onPress={() => { console.log(`[MathSpike] pressed row ${index + 1}`); setSelected(index); }} />
        ))}
      </View>
      <Text style={s.ui}>End of spike</Text>
    </ScrollView>
  );
}

/** What the engine itself returns for the math, before the symbol fallback. The engine
 * catches its own errors and only logs them, so the logged Error is captured here with its
 * stack, which names the function that threw. */
function diagnoseSpeech(mathml: string): string {
  const log = console.log;
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    for (const arg of args) if (arg instanceof Error) errors.push(arg.stack ?? String(arg));
    log(...args);
  };
  let result: string;
  try { result = JSON.stringify(speak(mathml)); }
  catch (error) { result = `threw ${String((error as Error)?.stack ?? error)}`; }
  finally { console.log = log; }
  if (errors.length) {
    log(`[MathSpike] speech engine error stack:\n${errors.join("\n---\n")}`);
    result += `; engine error: ${errors[0]}`;
  }
  return result;
}

/** The design under test: one accessible radio row whose label is spoken whole,
 * with its text and math drawing hidden from screen readers. */
function ChoiceRow({ pieces, label, selected, onPress }: {
  pieces: LabelPiece[]; label: string; selected: boolean; onPress: () => void;
}) {
  const { c, s } = useTheme();
  return (
    <Pressable accessible accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled: false }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm,
        borderRadius: radius.md, borderCurve: "continuous", borderWidth: 1, borderColor: selected ? c.primary : c.border,
        backgroundColor: selected || pressed ? c.hover : "transparent",
      })}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
        marginTop: 3, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1,
        borderRadius: 8, borderColor: selected ? c.primary : c.rail, backgroundColor: selected ? c.primary : "transparent",
      }}>
        {selected && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.onPrimary }} />}
      </View>
      <MathLabel pieces={pieces} style={[s.prose, { fontSize: 14, lineHeight: 20 }]} fontSize={14} color={c.text} />
    </Pressable>
  );
}
