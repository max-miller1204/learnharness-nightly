import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, Text, TextInput, View } from "react-native";
import { MenuView } from "@react-native-menu/menu";
import type { ChatListItem } from "../../../src/client-protocol/index.ts";
import { DELETE_SESSION_COPY } from "../../../src/core/session-delete-copy.ts";
import type { MobileApi } from "./protocol";
import { deleteSession } from "./session-actions";
import { KIND_FILTERS, type SessionAction, type SessionKindFilter, type sessionActions } from "./session-list";
import { alpha, fonts, radius, space, useTheme } from "./theme";

/** The Sessions header's search field (components/sidebar.tsx). */
export function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { c, s } = useTheme();
  return (
    <TextInput value={value} onChangeText={onChange} placeholder="Search…" accessibilityLabel="Search sessions"
      placeholderTextColor={alpha(c.muted, 0.6)} selectionColor={c.accent} autoCapitalize="none" autoCorrect={false}
      returnKeyType="search" clearButtonMode="while-editing"
      style={[s.input, { minHeight: 36, backgroundColor: c.background, fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 17, paddingVertical: 6 }]} />
  );
}

/** Teaching / Practice / All, under the search. */
export function KindSwitch({ value, onChange }: { value: SessionKindFilter; onChange: (value: SessionKindFilter) => void }) {
  const { c } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Session kind"
      style={{ flexDirection: "row", gap: 2, padding: 2, borderRadius: radius.md, borderCurve: "continuous", borderWidth: 1, borderColor: alpha(c.border, 0.6), backgroundColor: c.background }}>
      {KIND_FILTERS.map(({ value: kind, label }) => {
        const selected = kind === value;
        return (
          <Pressable key={kind} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected, checked: selected }} onPress={() => onChange(kind)}
            style={{ flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: radius.sm, backgroundColor: selected ? c.hover : "transparent" }}>
            <Text style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 15, letterSpacing: 0.6, textTransform: "uppercase", color: selected ? c.text : c.muted }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A session row. On a server with session basics, a long press opens the system
 *  menu (T3, thread-list-v2-items.tsx) and screen readers get the same actions. */
export function SessionRow({ chat, actions, onOpen, onAction }: {
  chat: ChatListItem; actions: ReturnType<typeof sessionActions>; onOpen: () => void; onAction: (action: SessionAction) => void;
}) {
  const { c, s } = useTheme();
  const row = (
    <Pressable accessibilityRole="button" onPress={onOpen}
      accessibilityActions={actions.map(({ id, label }) => ({ name: id, label }))}
      onAccessibilityAction={({ nativeEvent }) => onAction(nativeEvent.actionName as SessionAction)}
      style={({ pressed }) => ({ marginBottom: 2, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: pressed ? c.hover : "transparent" })}>
      <Text numberOfLines={1} style={s.prose}>{chat.title}</Text>
      <Text style={s.meta}>{chat.kind === "practice" ? "Practice" : "Teaching"}{chat.busy ? " · Reply in progress" : ""}</Text>
    </Pressable>
  );
  if (!actions.length) return row;
  return (
    <MenuView shouldOpenOnLongPress themeVariant={c.mode} onPressAction={({ nativeEvent }) => onAction(nativeEvent.event as SessionAction)}
      actions={actions.map(({ id, title, destructive }) => destructive ? { id, title, attributes: { destructive }, titleColor: c.error } : { id, title })}>
      {row}
    </MenuView>
  );
}

/** A centered box over the list, in the web dialog's look. */
function Box({ label, blocked, onClose, children }: { label: string; blocked: boolean; onClose: () => void; children: ReactNode }) {
  const { c } = useTheme();
  const close = () => { if (!blocked) onClose(); };
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable accessible={false} onPress={close} style={{ flex: 1, justifyContent: "center", padding: space.lg, backgroundColor: alpha(c.background, 0.8) }}>
          <Pressable accessibilityViewIsModal accessibilityLabel={label} onPress={() => {}}
            style={{ padding: 20, borderRadius: radius.lg, borderCurve: "continuous", borderWidth: 1, borderColor: c.border, backgroundColor: c.card,
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)" }}>
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The web dialog's bottom pair: a quiet Cancel and a red-bordered action. */
function BoxButton({ children, onPress, disabled, destructive }: { children: string; onPress: () => void; disabled?: boolean; destructive?: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, opacity: disabled ? 0.4 : 1,
        ...(destructive ? { borderWidth: 1, borderColor: c.errorBorder, backgroundColor: pressed ? alpha(c.error, 0.2) : c.errorTint } : pressed && { backgroundColor: c.hover }) })}>
      <Text style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 15, color: destructive ? c.error : c.muted }}>{children}</Text>
    </Pressable>
  );
}

/** Android's rename prompt (iOS uses the system one), T3's Dialog.android.tsx. */
export function RenameBox({ title, onCancel, onRename }: { title: string; onCancel: () => void; onRename: (value: string) => void }) {
  const { c, s } = useTheme();
  const [value, setValue] = useState(title);
  return (
    <Box label="Rename session" blocked={false} onClose={onCancel}>
      <Text accessibilityRole="header" style={[s.heading, { fontSize: 14, lineHeight: 20 }]}>Rename session</Text>
      <TextInput value={value} onChangeText={setValue} autoFocus selectTextOnFocus accessibilityLabel="Session title" returnKeyType="done"
        onSubmitEditing={() => onRename(value)} selectionColor={c.accent} placeholderTextColor={c.muted} style={[s.input, { marginTop: space.md }]} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.lg }}>
        <BoxButton onPress={onCancel}>Cancel</BoxButton>
        <Pressable accessibilityRole="button" onPress={() => onRename(value)} hitSlop={6}
          style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: c.primary, opacity: pressed ? 0.9 : 1 })}>
          <Text style={{ fontFamily: fonts.uiMedium, fontSize: 11, lineHeight: 15, color: c.onPrimary }}>Rename</Text>
        </Pressable>
      </View>
    </Box>
  );
}

/** The web's delete box (components/delete-session-dialog.tsx): the graph-traces
 *  checkbox picks the mode on every press, Try again included. */
export function DeleteBox({ api, chat, onClose, onDeleted, connectionFault }: {
  api: MobileApi; chat: Pick<ChatListItem, "id" | "title">; onClose: () => void; onDeleted: (id: string) => void; connectionFault: (error: unknown) => boolean;
}) {
  const { c, s } = useTheme();
  const [traces, setTraces] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const scope = useRef(new AbortController());
  useEffect(() => {
    const lifetime = new AbortController();
    scope.current = lifetime;
    return () => lifetime.abort();
  }, []);

  async function run() {
    if (busy) return;
    setBusy(true);
    const retry = !!failure;
    setFailure("");
    const outcome = await deleteSession(api, chat.id, traces, retry, scope.current.signal);
    if (scope.current.signal.aborted) return;
    if (outcome.deleted) return onDeleted(chat.id);
    if (connectionFault(outcome.error)) return;
    setFailure(outcome.message);
    setBusy(false);
  }

  return (
    <Box label="Delete session" blocked={busy} onClose={onClose}>
      <Text accessibilityRole="header" style={{ fontFamily: fonts.uiMedium, fontSize: 12.5, lineHeight: 18, color: c.error }}>{DELETE_SESSION_COPY.title}</Text>
      <Text style={[s.ui, { marginTop: 6 }]}>{chat.title}</Text>
      <Text style={[s.muted, { marginTop: space.sm }]}>{DELETE_SESSION_COPY.body}</Text>
      <Pressable accessibilityRole="checkbox" accessibilityLabel={DELETE_SESSION_COPY.tracesTitle} accessibilityState={{ checked: traces, disabled: busy }}
        disabled={busy} onPress={() => setTraces((value) => !value)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: space.lg, paddingHorizontal: space.lg, paddingVertical: space.md,
          borderRadius: radius.lg, borderCurve: "continuous", borderWidth: 1, borderColor: alpha(c.border, 0.6) }}>
        <View style={{ width: 16, height: 16, marginTop: 2, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1,
          borderColor: traces ? c.primary : c.border, backgroundColor: traces ? c.primary : c.input, opacity: busy ? 0.5 : 1 }}>
          {traces && <Text style={{ fontSize: 11, lineHeight: 13, color: c.onPrimary }}>✓</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.ui}>{DELETE_SESSION_COPY.tracesTitle}</Text>
          <Text style={[s.meta, { marginTop: space.xs }]}>{DELETE_SESSION_COPY.tracesBody}</Text>
        </View>
      </Pressable>
      {!!failure && (
        <View accessibilityRole="alert" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md, rowGap: space.xs, marginTop: space.md,
          paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: alpha(c.border, 0.6) }}>
          <Text selectable style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 15, color: c.text, flexShrink: 1 }}>{failure}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run()} hitSlop={6}>
            <Text style={{ fontFamily: fonts.ui, fontSize: 11, lineHeight: 15, color: c.text }}>{DELETE_SESSION_COPY.retry}</Text>
          </Pressable>
        </View>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.lg }}>
        <BoxButton disabled={busy} onPress={onClose}>{DELETE_SESSION_COPY.cancel}</BoxButton>
        <BoxButton destructive disabled={busy} onPress={() => void run()}>{busy ? DELETE_SESSION_COPY.busy : DELETE_SESSION_COPY.confirm}</BoxButton>
      </View>
    </Box>
  );
}
