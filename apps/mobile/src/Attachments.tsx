import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { AttachmentReference } from "../../../src/client-protocol/index.ts";
import { ATTACHMENT_UNAVAILABLE } from "../../../src/core/attachment-limits.ts";
import type { Attachments, PickKind } from "./use-attachments";
import { Button, Notice } from "./ui";
import { radius, space, useTheme } from "./theme";

export const NEEDS_TEXT = "Add a message to send these files.";

const CHOICES: { kind: PickKind; label: string }[] = [
  { kind: "camera", label: "Take photo" },
  { kind: "photos", label: "Photo library" },
  { kind: "files", label: "Files" },
];

/** The web's lucide paperclip. */
function Paperclip({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M13.234 20.252 21 12.3" />
      <Path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486" />
    </Svg>
  );
}

export function AttachButton({ open, setOpen, disabled }: { open: boolean; setOpen: (open: boolean) => void; disabled: boolean }) {
  const { c } = useTheme();
  return (
    <Button variant="ghost" label="Attach" selected={false} disabled={disabled} onPress={() => setOpen(!open)}
      style={[{ width: 40, paddingHorizontal: 0, borderRadius: radius.control }, open && { backgroundColor: c.hover }]}>
      <Paperclip color={c.text} />
    </Button>
  );
}

/** The paperclip's choices, in the composer's column so every choice stays reachable. */
export function AttachMenu({ attachments, close }: { attachments: Attachments; close: () => void }) {
  const { c, s } = useTheme();
  return (
    <View accessibilityRole="menu" style={{ alignSelf: "flex-start", minWidth: 200, padding: space.xs, borderRadius: radius.lg, borderCurve: "continuous",
      borderWidth: 1, borderColor: c.border, backgroundColor: c.card, boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.25)" }}>
      {CHOICES.map(({ kind, label }) => (
        <Pressable key={kind} accessibilityRole="menuitem" accessibilityLabel={label} onPress={() => { close(); void attachments.choose(kind); }}
          style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: space.sm, borderRadius: radius.md, borderCurve: "continuous",
            backgroundColor: pressed ? c.hover : "transparent" })}>
          <Text style={s.ui}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Chip({ name, children }: { name: string; children?: ReactNode }) {
  const { c, s } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, maxWidth: "100%",
      paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border }}>
      <Paperclip color={c.text} size={12} />
      <Text numberOfLines={1} style={[s.ui, { fontSize: 12, flexShrink: 1 }]}>{name}</Text>
      {children}
    </View>
  );
}

function ChipAction({ label, name, onPress }: { label: string; name: string; onPress: () => void }) {
  const { s } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${name}`} hitSlop={8} onPress={onPress}>
      <Text style={[s.ui, { fontSize: 12, textDecorationLine: "underline" }]}>{label}</Text>
    </Pressable>
  );
}

/** The draft's files above the text box: progress, then Retry or Remove. */
export function DraftChips({ attachments, needsText }: { attachments: Attachments; needsText: boolean }) {
  const { c, s } = useTheme();
  if (!attachments.rows.length && !attachments.notice) return null;
  return (
    <View style={{ gap: space.xs }}>
      {attachments.rows.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        {attachments.rows.map((row) => (
          <Chip key={row.key} name={row.name}>
            {row.error
              ? <>
                <Text accessibilityRole="alert" style={[s.error, { fontSize: 12 }]}>{row.error}</Text>
                <ChipAction label="Retry" name={row.name} onPress={() => attachments.retry(row)} />
              </>
              : !row.ready && <View accessibilityRole="progressbar" accessibilityLabel={`Uploading ${row.name}`}
                accessibilityValue={{ min: 0, max: 100, now: row.progress }}
                style={{ width: 48, height: 4, borderRadius: 2, backgroundColor: c.rail, overflow: "hidden" }}>
                <View style={{ width: `${row.progress}%`, height: "100%", backgroundColor: c.text }} />
              </View>}
            <ChipAction label="Remove" name={row.name} onPress={() => attachments.remove(row)} />
          </Chip>
        ))}
      </View>}
      <Notice>{attachments.notice}</Notice>
      {needsText && attachments.rows.length > 0 && <Text style={s.meta}>{NEEDS_TEXT}</Text>}
    </View>
  );
}

/** A saved message's files, as the web's SavedAttachmentChips shows them. */
export function SavedChips({ files, unavailable }: { files: readonly AttachmentReference[]; unavailable: ReadonlySet<string> }) {
  const { s } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
      {files.map(({ id, name, fileCount }) => (
        <Chip key={id} name={fileCount === undefined ? name : `${name} · ${fileCount} ${fileCount === 1 ? "file" : "files"}`}>
          {unavailable.has(id) && <Text style={[s.muted, { fontSize: 12 }]}>{ATTACHMENT_UNAVAILABLE}</Text>}
        </Chip>
      ))}
    </View>
  );
}
