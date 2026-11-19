import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { QuestionAnswerData } from "../../../src/core/question-core.ts";
import { hasMath, joinPieces, plainText, splitLabel } from "./choice-math";
import { spokenLabel } from "./math-speech";
import { MathLabel, useSpeech } from "./MathLabel";
import { useTheme } from "./theme";

/** The answered card's response line. Math in the chosen labels is drawn, and the line is
 * one screen-reader stop with the math spoken, never split into pieces. Typed text and
 * "Other" stay plain. A line without math is selectable text, as before; a line with
 * math copies its text, math as written, on a long press. */
export function AnswerLine({ answer }: { answer: Partial<QuestionAnswerData> }) {
  const { c, s } = useTheme();
  const [copied, setCopied] = useState(false);
  const response = answer.dismissed ? "Skipped" : answer.dontKnow ? "I don’t know" :
    [answer.text, ...answer.answers?.map(({ label }) => label) ?? [], answer.other].filter(Boolean).join(", ");
  const pieces = useMemo(() => answer.dismissed || answer.dontKnow ? plainText(response)
    : joinPieces([plainText(answer.text ?? ""), ...answer.answers?.map(({ label }) => splitLabel(label)) ?? [], plainText(answer.other ?? "")], ", "),
  [answer, response]);
  const drawn = hasMath(pieces);
  const speech = useSpeech(drawn);
  const spoken = useMemo(() => drawn ? spokenLabel(pieces, speech) : response, [drawn, pieces, speech, response]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!response) return null;
  if (!drawn) return <Text selectable style={s.prose}>{response}</Text>;
  const copy = () => { void Clipboard.setStringAsync(response).then(() => setCopied(true), () => {}); };
  return (
    <View>
      <Pressable accessibilityLabel={spoken} accessibilityActions={[{ name: "longpress", label: "Copy" }]}
        onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === "longpress") copy(); }} onLongPress={copy}>
        <MathLabel pieces={pieces} style={s.prose} color={c.text} />
      </Pressable>
      {copied && <Text accessibilityLiveRegion="polite" style={s.muted}>Copied</Text>}
    </View>
  );
}
