import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PendingQuestion } from "../../../src/core/pending.ts";
import { toolQuestionKind } from "../../../src/core/pending.ts";
import {
  buildAnswer, CONFIDENCE_STOPS, DEFAULT_CONFIDENCE_INDEX,
  emptyDockSelection, normalizeOptions, normalizeQuizType, resolveCorrect,
  seededRandom, shuffleOptions, toggleOption, toggleOther, type QuestionData,
} from "../../../src/core/question-core.ts";
import { parseQuestionInput } from "../../../src/core/tool-parts.ts";
import type { ChatInput } from "../../../src/client-protocol/index.ts";
import { Markdown } from "./Markdown";
import { Button, Field, Label } from "./ui";
import { alpha, confidenceColors, fonts, radius, space, useTheme } from "./theme";

/** The web dock's confidence slider: a thin rail with tick marks and a round
 *  handle that snaps to the six stops. Tap or drag anywhere on the rail. */
function ConfidenceRail({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (stop: number) => void }) {
  const { c, s } = useTheme();
  const width = useRef(0);
  const index = Math.max(0, CONFIDENCE_STOPS.indexOf(value));
  const color = confidenceColors[index] ?? confidenceColors[2];
  function pick(x: number) {
    // The rail spans the handle-center range: 8px in from each side.
    const percent = ((x - 8) / Math.max(1, width.current - 16)) * 100;
    const nearest = CONFIDENCE_STOPS.reduce((best, stop) => Math.abs(stop - percent) < Math.abs(best - percent) ? stop : best);
    if (nearest !== value) onChange(nearest);
  }
  const step = (by: number) => {
    const next = CONFIDENCE_STOPS[Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, index + by))];
    if (next !== undefined && next !== value) onChange(next);
  };
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View accessible accessibilityRole="adjustable" accessibilityLabel="Confidence" accessibilityValue={{ text: `${value} percent` }}
        accessibilityState={{ disabled }} accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => { if (!disabled) step(nativeEvent.actionName === "increment" ? 1 : -1); }}
        onLayout={({ nativeEvent }) => { width.current = nativeEvent.layout.width; }}
        onStartShouldSetResponder={() => !disabled} onMoveShouldSetResponder={() => !disabled}
        onResponderTerminationRequest={() => false}
        onResponderGrant={({ nativeEvent }) => pick(nativeEvent.locationX)}
        onResponderMove={({ nativeEvent }) => pick(nativeEvent.locationX)}
        hitSlop={{ top: 12, bottom: 12 }} style={{ flex: 1, height: 16, opacity: disabled ? 0.4 : 1 }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 8, right: 8, top: 5, height: 6, borderRadius: 3, borderWidth: 1, borderColor: c.border, backgroundColor: c.background, overflow: "hidden" }}>
          {[30, 50, 70, 90].map((tick) => <View key={tick} style={{ position: "absolute", left: `${tick}%`, top: 0, bottom: 0, width: 1, backgroundColor: alpha(c.text, 0.35) }} />)}
          <View style={{ width: `${value}%`, height: "100%", backgroundColor: color }} />
        </View>
        <View pointerEvents="none" style={{ position: "absolute", left: 8, right: 8, top: 0, height: 16 }}>
          <View style={{ position: "absolute", left: `${value}%`, marginLeft: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: color }} />
        </View>
      </View>
      <Text style={[s.ui, { width: 40, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{`${value}%`}</Text>
    </View>
  );
}

/** The web dock's option row: a radio dot or check box, then the label,
 *  rendered as markdown with math like the question (question-dock.tsx). */
function Option({ label, multi, selected, disabled, onPress }: {
  label: string; multi: boolean; selected: boolean; disabled: boolean; onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm,
        borderRadius: radius.md, borderCurve: "continuous", borderWidth: 1, borderColor: selected ? c.primary : c.border,
        backgroundColor: selected || pressed ? c.hover : "transparent", opacity: disabled ? 0.5 : 1,
      })}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
        marginTop: 4, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1,
        borderRadius: multi ? radius.sm : 8, borderColor: selected ? c.primary : c.rail, backgroundColor: selected ? c.primary : "transparent",
      }}>
        {selected && (multi ? <Text style={{ color: c.onPrimary, fontSize: 12, lineHeight: 14 }}>✓</Text>
          : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.onPrimary }} />)}
      </View>
      {/* The math view would take the tap, so the whole row stays the button. */}
      <View pointerEvents="none" style={{ flex: 1 }}><Markdown text={label} /></View>
    </Pressable>
  );
}

export function questionData(pending: PendingQuestion): QuestionData | undefined {
  const raw = parseQuestionInput(pending.tool, pending.input);
  if (!raw) return;
  const kind = toolQuestionKind(pending.tool);
  const options = normalizeOptions("options" in raw ? raw.options ?? [] : []);
  const ordered = kind === "quiz" ? shuffleOptions(options, seededRandom(pending.toolCallId)) : options;
  const data: QuestionData = {
    id: pending.toolCallId,
    kind,
    questionType: kind === "quiz" && "type" in raw ? normalizeQuizType(raw.type) : undefined,
    question: raw.question,
    context: raw.details,
    mode: ordered.length === 0 ? "text" : "multiSelect" in raw && raw.multiSelect ? "multi-select" : "single-select",
    options: ordered,
    createdAt: new Date().toISOString(),
  };
  if (kind === "quiz" && "correctAnswer" in raw) {
    data.correctIndices = resolveCorrect(raw.correctAnswer, ordered).indices;
    if ("explanation" in raw) data.explanation = raw.explanation;
  }
  if (kind === "explain" && "correctAnswer" in raw && typeof raw.correctAnswer === "string") data.committedAnswer = raw.correctAnswer;
  return data;
}

/** The teach-check invitation (question-dock.tsx QuestionDockBar, reveal variant). */
function RevealBar({ question, onOpen }: { question: string; onOpen: () => void }) {
  const { c, s } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Check your understanding" accessibilityHint="Opens the question" onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.md, borderCurve: "continuous",
        backgroundColor: pressed ? c.hover : "transparent" })}>
      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: alpha(c.primary, 0.15) }}>
        <Text style={{ color: c.primary, fontSize: 11 }}>▶</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.ui, { fontFamily: fonts.uiMedium, fontSize: 14 }]}>Check your understanding</Text>
        {/* The question's first line, rendered (math included) like the web's QuestionPreview. */}
        <View pointerEvents="none" style={{ maxHeight: 24, overflow: "hidden", opacity: 0.7 }}><Markdown text={question} /></View>
      </View>
      <Text style={[s.ui, { fontFamily: fonts.uiMedium, fontSize: 11 }]}>Open ›</Text>
    </Pressable>
  );
}

export function BuiltinQuestion({ question, disabled, submit, reveal, openAtStart, skip }: {
  question: PendingQuestion; disabled: boolean; submit: (input: ChatInput) => void;
  /** A teach-phase check: it waits closed behind its invitation, with the thinking-while-reading field. */
  reveal: boolean;
  /** A check that directly follows another question arrives open (chat.tsx revealArrival). */
  openAtStart: boolean;
  /** lesson-view-v1: skip the question, carrying any thinking while reading. It stays
   * available mid-turn, where the skip also stops the turn. */
  skip?: { disabled: boolean; run: (readingThinking: string) => void };
}) {
  const { s } = useTheme();
  const data = useMemo(() => questionData(question), [question]);
  const [reading, setReading] = useState("");
  const [revealed, setRevealed] = useState(!reveal || openAtStart);
  const [selection, setSelection] = useState(emptyDockSelection);
  const [answer, setAnswer] = useState("");
  const [other, setOther] = useState("");
  const [thinking, setThinking] = useState("");
  const [confidence, setConfidence] = useState(CONFIDENCE_STOPS[DEFAULT_CONFIDENCE_INDEX]);

  if (!data) return null;
  const { mode } = data;
  const ready = mode === "text" ? !!answer.trim()
    : (selection.selected.size > 0 || (selection.otherSelected && !!other.trim())) && (!selection.otherSelected || !!other.trim());

  function send(dontKnow = false) {
    if (!data) return;
    const values = [...selection.selected].flatMap((index) => data.options[index]?.value ?? []);
    submit({
      type: "answer",
      toolCallId: question.toolCallId,
      answer: buildAnswer(data, {
        dontKnow,
        values: dontKnow ? [] : values,
        text: !dontKnow && mode === "text" ? answer : undefined,
        other: !dontKnow && selection.otherSelected ? other : undefined,
        confidence,
        thinking,
        readingThinking: reveal ? reading : undefined,
      }, question.tool),
    });
  }

  const multi = mode === "multi-select";
  const readingField = reveal && (
    <Field label="Thinking while reading" placeholder="Whatever comes to mind as you read." value={reading} onChangeText={setReading}
      editable={!disabled} multiline />
  );
  if (!revealed) return <View style={{ gap: space.md }}>{readingField}<RevealBar question={data.question} onOpen={() => setRevealed(true)} /></View>;
  return (
    <View style={{ gap: space.md }}>
      {readingField}
      <View style={{ gap: space.xs }}>
        <Label>{data.kind === "quiz" ? "Quiz" : "Question"}</Label>
        <Markdown text={data.question} />
        {!!data.context && <Markdown text={data.context} />}
      </View>
      {mode === "text" ? (
        <Field label="Your answer" value={answer} onChangeText={setAnswer} editable={!disabled} multiline />
      ) : (
        <View style={{ gap: space.sm }}>
          {data.options.map((option, index) => (
            <Option key={index} label={option.label} multi={multi} selected={selection.selected.has(index)} disabled={disabled}
              onPress={() => setSelection((value) => toggleOption(mode, value, index))} />
          ))}
          {data.kind === "ask" && (
            <>
              <Option label="Other" multi={multi} selected={selection.otherSelected} disabled={disabled}
                onPress={() => setSelection((value) => toggleOther(mode, value))} />
              {selection.otherSelected && <Field label="Other answer" value={other} onChangeText={setOther} editable={!disabled} />}
            </>
          )}
        </View>
      )}
      {data.kind === "quiz" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Label>Confidence</Label>
          <ConfidenceRail value={confidence ?? 50} disabled={disabled} onChange={setConfidence} />
        </View>
      )}
      <Field label="Your thinking (optional)" value={thinking} onChangeText={setThinking} editable={!disabled} multiline />
      <View style={s.row}>
        <Button disabled={disabled || !ready} primary onPress={() => send()}>Submit answer</Button>
        {data.kind !== "ask" && <Button disabled={disabled} onPress={() => send(true)}>I don’t know</Button>}
        {skip && <Button variant="ghost" disabled={skip.disabled} onPress={() => skip.run(reveal ? reading : "")}>Skip</Button>}
      </View>
    </View>
  );
}
