import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { TOOL_STEPS, toolStepHeadline, toolStepOutput } from "../../../src/core/tool-steps.ts";
import type { LhViewPart } from "../../../src/core/view.ts";
import { fonts, radius, space, useTheme } from "./theme";

/** Whether a transcript part is a tool step: a call to one of TOOL_STEPS, or a show_image
 *  call that hasn't shown its picture (still running, or failed), as on the web. */
export function isToolStep(part: LhViewPart): boolean {
  if (!part.type.startsWith("tool-")) return false;
  const tool = part.type.slice("tool-".length);
  return TOOL_STEPS.includes(tool) || (tool === "show_image" && part.state !== "output-available");
}

/** One section of an opened step: its small uppercase heading and the text in mono, scrolling
 *  past `maxHeight`. */
function Section({ heading, text, maxHeight, error }: { heading: string; text: string; maxHeight: number; error?: boolean }) {
  const { c, s } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.label}>{heading}</Text>
      <ScrollView nestedScrollEnabled style={{ maxHeight }}>
        <Text selectable style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 17, color: error ? c.error : c.text }}>{text}</Text>
      </ScrollView>
    </View>
  );
}

/** A tool step (the web's ToolCallCard): a quiet one-line row with the tool's name, red when
 *  the call failed, and its headline argument, collapsed by default and opening to the call's
 *  input and its output, its error, or that it is still running. The row is laid out as T3's
 *  mobile work-log row: one line that ends in an ellipsis, the chevron at its end, one
 *  screen-reader stop that says whether it is open. */
export function ToolStep({ part }: { part: LhViewPart }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const tool = part.type.slice("tool-".length);
  const headline = toolStepHeadline(tool, part.input);
  const failed = part.state === "output-error" || typeof part.errorText === "string";
  const output = toolStepOutput(part.output);
  const said = [tool, headline].filter(Boolean).join(" ");
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={failed ? `${said}, tool call failed` : said}
        accessibilityHint={open ? "Hides the call's input and output." : "Shows the call's input and output."}
        accessibilityState={{ expanded: open }} hitSlop={4} onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: 2, borderRadius: radius.sm, backgroundColor: pressed ? c.hover : "transparent" })}>
        <Text numberOfLines={1} style={[s.label, failed && { color: c.error }]}>{tool}</Text>
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
