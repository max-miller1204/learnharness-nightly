import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  PROTOCOL_ROUTES, PRACTICE_CONTROLS_V1, PRACTICE_CONTROL_ROUTES, hasCapability,
  type ChatKind, type ChatListResponse, type CreateChatRequest, type CreateChatResponse,
  type GraphContextPick, type PracticePropositionsResponse, type ServerInfo,
} from "../../../src/client-protocol/index.ts";
import { ApiError, type MobileApi } from "./protocol";
import { errorText } from "./use-session";
import { Button, Field, Notice } from "./ui";
import { fonts, radius, space, useTheme } from "./theme";

const MAX_PICKS = 64;

export function NewSession({ api, info, kind, back, open, connectionFault }: {
  api: MobileApi; info: ServerInfo; kind: ChatKind; back: () => void;
  open: (id: string, draft?: string, sendDraft?: boolean) => void; connectionFault: (error: unknown) => boolean;
}) {
  const { c, s } = useTheme();
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [propositions, setPropositions] = useState<GraphContextPick[]>();
  const [picks, setPicks] = useState<GraphContextPick[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [graphRevision, setGraphRevision] = useState(0);
  const [recent, setRecent] = useState<ChatListResponse["chats"]>();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  // Graph picks ride the creation for teaching and practice alike (home.tsx).
  const canPick = hasCapability(info, PRACTICE_CONTROLS_V1);

  useEffect(() => {
    if (!picking) return;
    const scope = new AbortController();
    api.get<PracticePropositionsResponse>(PRACTICE_CONTROL_ROUTES.propositions, scope.signal).then(({ propositions }) => {
      if (!scope.signal.aborted) setPropositions(propositions);
    }).catch((error) => {
      if (!scope.signal.aborted && !connectionFault(error)) setGraphError(errorText(error));
    });
    return () => scope.abort();
  }, [api, connectionFault, graphRevision, picking]);

  const filtered = useMemo(() => {
    const search = query.toLowerCase().trim();
    return propositions?.filter(({ name, statement }) => `${name} ${statement}`.toLowerCase().includes(search)) ?? [];
  }, [propositions, query]);

  async function create() {
    const text = draft.trim();
    if (!text || operation.current) return;
    const scope = new AbortController();
    const signal = scope.signal;
    operation.current = scope;
    setBusy(true);
    setError("");
    setRecent(undefined);

    let before: ChatListResponse;
    try {
      before = await api.get<ChatListResponse>(PROTOCOL_ROUTES.chats, signal);
    } catch (error) {
      if (!signal.aborted && !connectionFault(error)) setError(errorText(error));
      operation.current = null;
      if (!signal.aborted) setBusy(false);
      return;
    }

    try {
      const body: CreateChatRequest = {
        title: text,
        ...(kind === "practice" ? { kind } : {}),
        ...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}),
      };
      const { id } = await api.post<CreateChatResponse>(PROTOCOL_ROUTES.chats, body, signal);
      if (!signal.aborted) open(id, text, true);
    } catch (error) {
      if (signal.aborted || connectionFault(error)) return;
      if (error instanceof ApiError && error.status < 500) {
        setError(errorText(error));
        return;
      }
      try {
        const after = await api.get<ChatListResponse>(PROTOCOL_ROUTES.chats, signal);
        if (signal.aborted) return;
        const known = new Set(before.chats.map(({ id }) => id));
        setRecent(after.chats.filter((chat) => !known.has(chat.id)));
        setError("The server didn't confirm creation. Check newly created sessions before trying again.");
      } catch (refreshError) {
        if (!signal.aborted && !connectionFault(refreshError)) setError("Couldn't confirm creation. Check the session list before starting again.");
      }
    } finally {
      operation.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  if (picking) {
    return (
      <>
        <View style={[s.bar, { paddingVertical: space.md }]}>
          <Text accessibilityRole="header" style={[s.heading, { flex: 1 }]}>Graph material</Text>
          <Button primary onPress={() => setPicking(false)}>{`Done (${picks.length})`}</Button>
        </View>
        <View style={{ padding: space.lg, paddingBottom: 0, gap: space.sm }}>
          <Field label="Search propositions" value={query} onChangeText={setQuery} />
          {!!graphError && <View style={s.row}><Button onPress={() => { setGraphError(""); setGraphRevision((n) => n + 1); }}>Retry</Button></View>}
          <Notice>{graphError}</Notice>
        </View>
        <FlatList data={filtered} keyExtractor={({ id }) => id} keyboardShouldPersistTaps="handled"
          contentContainerStyle={[s.section, { gap: space.sm }]} ListEmptyComponent={
            graphError ? undefined : <Text style={s.muted}>{propositions ? "No matching propositions" : "Loading propositions…"}</Text>
          }
          renderItem={({ item }) => {
            const selected = picks.some(({ id }) => id === item.id);
            const disabled = !selected && picks.length >= MAX_PICKS;
            return (
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled }} disabled={disabled}
                onPress={() => setPicks((value) => selected ? value.filter(({ id }) => id !== item.id) : [...value, item])}
                style={({ pressed }) => ({
                  flexDirection: "row", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm,
                  borderRadius: radius.md, borderCurve: "continuous", borderWidth: 1, borderColor: selected ? c.primary : c.border,
                  backgroundColor: selected || pressed ? c.hover : "transparent", opacity: disabled ? 0.5 : 1,
                })}>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ marginTop: 3, width: 16, height: 16, borderRadius: radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center",
                  borderColor: selected ? c.primary : c.rail, backgroundColor: selected ? c.primary : "transparent" }}>
                  {selected && <Text style={{ color: c.onPrimary, fontSize: 12, lineHeight: 14 }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.prose, { fontFamily: fonts.proseBold }]}>{item.name}</Text>
                  <Text style={[s.prose, { fontSize: 14, lineHeight: 20, color: c.muted }]}>{item.statement}</Text>
                </View>
              </Pressable>
            );
          }} />
      </>
    );
  }

  const prompt = kind === "practice" ? "What do you want to practice?" : "What do you want to learn?";
  return (
    <>
      <View style={{ flexDirection: "row", padding: space.md }}>
        <Button variant="ghost" label="Sessions" disabled={busy} onPress={back} style={{ paddingHorizontal: space.sm }}>‹ Sessions</Button>
      </View>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", gap: space.xs, padding: 32 }}>
        <Text accessibilityRole="header" style={[s.ui, { fontFamily: fonts.uiMedium, fontSize: 14, textAlign: "center" }]}>
          {kind === "practice" ? "New practice session" : "New session"}
        </Text>
        <Text style={[s.muted, { textAlign: "center" }]}>
          {kind === "practice"
            ? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
            : "The teacher will open by probing what you already know."}
        </Text>
      </ScrollView>
      <View style={{ paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm }}>
        {canPick && <View style={s.row}>
          <Button disabled={busy} onPress={() => { setGraphError(""); setPicking(true); }} style={{ minHeight: 32, paddingHorizontal: space.md }}>
            {picks.length ? `Graph material (${picks.length})` : "Pick graph material"}
          </Button>
        </View>}
        {picks.length > 0 && <Text style={s.meta}>{picks.map(({ name }) => name).join(", ")}</Text>}
        <Notice>{error}</Notice>
        {recent?.map((chat) => <Button key={chat.id} onPress={() => open(chat.id, draft.trim())}>{chat.title}</Button>)}
        <View style={[s.dock, { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 6 }]}>
          <TextInput accessibilityLabel={prompt} placeholder={prompt} placeholderTextColor={c.muted} selectionColor={c.accent}
            value={draft} onChangeText={setDraft} multiline editable={!busy}
            style={{ flex: 1, minHeight: 40, maxHeight: 192, paddingHorizontal: 10, paddingVertical: 10, fontFamily: fonts.prose, fontSize: 16, lineHeight: 20, color: c.text, textAlignVertical: "top" }} />
          <Button primary label={busy ? "Starting…" : "Start session"} disabled={busy || !draft.trim() || (!!recent && recent.length > 0)} onPress={() => void create()}
            style={{ width: 40, paddingHorizontal: 0, borderRadius: radius.control }}>
            <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: c.onPrimary }}>{busy ? "…" : "↵"}</Text>
          </Button>
        </View>
      </View>
    </>
  );
}
