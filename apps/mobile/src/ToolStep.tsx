import { useEffect, useState } from "react";
import { Animated, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { toolActivityLabel } from "../../../src/core/pending.ts";
import { capToolText, TOOL_STEPS, toolStepHeadline, toolStepOutput } from "../../../src/core/tool-steps.ts";
import type { LhViewPart } from "../../../src/core/view.ts";
import { fonts, radius, space, useTheme } from "./theme";
import { useReduceMotion } from "./ui";

/** The longest headline a screen reader is given, in characters. */
const SPOKEN_HEADLINE = 200;

/** Whether a transcript part is a tool step: a call to one of TOOL_STEPS, or a show_image
 *  call that hasn't shown its picture (still running, or failed), as on the web. */
export function isToolStep(part: LhViewPart): boolean {
  if (!part.type.startsWith("tool-")) return false;
  const tool = part.type.slice("tool-".length);
  return TOOL_STEPS.includes(tool) || (tool === "show_image" && part.state !== "output-available");
}

/** Whether a step's call is still running: no result yet. */
export const isRunning = (part: LhViewPart) => part.state === "input-streaming" || part.state === "input-available";

/** One section of an opened step: its small uppercase heading and the text in mono, cut by
 *  capToolText, scrolling past `maxHeight`. It never takes the status bar's scroll to top,
 *  which belongs to the transcript (docs/specs/mobile-session-open.md). */
function Section({ heading, text, maxHeight, error }: { heading: string; text: string; maxHeight: number; error?: boolean }) {
  const { c, s } = useTheme();
  const { text: shown, note } = capToolText(text);
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.label}>{heading}</Text>
      <ScrollView nestedScrollEnabled scrollsToTop={false} style={{ maxHeight }}>
        <Text selectable style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 17, color: error ? c.error : c.text }}>{shown}</Text>
      </ScrollView>
      {!!note && <Text style={s.meta}>{note}</Text>}
    </View>
  );
}

/** A running step's activity label, as the web's live card shows it (live-tool-card.tsx),
 *  breathing as T3's running work-log row shimmers (thread-work-log.tsx's
 *  ShimmeringWorkContent): still when Reduce Motion is on. */
function Working({ label }: { label: string }) {
  const { s } = useTheme();
  // Still until the system says motion is fine.
  const reduceMotion = useReduceMotion(true);
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.setValue(1);
    if (reduceMotion) return;
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.45, duration: 800, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    pulse.start();
    return () => pulse.stop();
  }, [opacity, reduceMotion]);
  return <Animated.Text numberOfLines={1} style={[s.meta, { opacity }]}>{label}</Animated.Text>;
}

/** A tool step (the web's ToolCallCard): a quiet one-line row with the tool's name, red when
 *  the call failed, and its headline argument, collapsed by default and opening to the call's
 *  input and its output, its error, or that it is still running. While the call runs in the
 *  live turn (`running`), the name gives way to its activity label, as the web's live card's
 *  does; the row's size doesn't change when the call settles. The row is laid out as T3's
 *  mobile work-log row: one line that ends in an ellipsis, the chevron at its end, one
 *  screen-reader stop that says whether it is open. Fabric speaks "expanded" for an open row
 *  but nothing for a closed one, so a closed row says "collapsed" as its value on iOS. */
export function ToolStep({ part, running = false }: { part: LhViewPart; running?: boolean }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const tool = part.type.slice("tool-".length);
  const headline = toolStepHeadline(tool, part.input);
  const failed = part.state === "output-error" || typeof part.errorText === "string";
  const output = toolStepOutput(part.output);
  const spoken = headline.length > SPOKEN_HEADLINE ? `${headline.slice(0, SPOKEN_HEADLINE)}…` : headline;
  const said = [running ? toolActivityLabel(tool) : tool, spoken].filter(Boolean).join(" ");
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={failed ? `${said}, tool call failed` : said}
        accessibilityHint={open ? "Hides the call's input and output." : "Shows the call's input and output."}
        accessibilityState={{ expanded: open }} accessibilityValue={Platform.OS === "ios" && !open ? { text: "collapsed" } : undefined}
        hitSlop={4} onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: 2, borderRadius: radius.sm, backgroundColor: pressed ? c.hover : "transparent" })}>
        {running ? <Working label={toolActivityLabel(tool)} />
          : <Text numberOfLines={1} style={[s.label, failed && { color: c.error }]}>{tool}</Text>}
        <Text numberOfLines={1} ellipsizeMode="tail" style={[s.meta, { flex: 1, minWidth: 0 }]}>{headline}</Text>
        <Text style={[s.label, { fontSize: 14 }]}>{open ? "⌃" : "⌄"}</Text>
      </Pressable>
      {open && (
        <View style={[s.card, { padding: space.md, gap: space.sm, marginTop: space.xs }]}>
          {part.input != null && <Section heading="Input" text={JSON.stringify(part.input, null, 2)} maxHeight={128} />}
          {typeof part.errorText === "string" ? <Section heading="Error" text={part.errorText} maxHeight={256} error />
            : output != null ? <Section heading="Output" text={output} maxHeight={256} />
              : part.state !== "output-available" && <Text style={[s.meta, { fontStyle: "italic" }]}>running…</Text>}
        </View>
      )}
    </View>
  );
}
