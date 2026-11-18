import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import {
  PROTOCOL_ROUTES, PRACTICE_CONTROLS_V1, PRACTICE_CONTROL_ROUTES, hasCapability,
  type ChatKind, type ChatListResponse, type CreateChatRequest, type CreateChatResponse,
  type GraphContextPick, type PracticePropositionsResponse, type ServerInfo,
} from "../../../src/client-protocol/index.ts";
import { ApiError, type MobileApi } from "./protocol";
import { errorText } from "./use-session";
import { Button, colors, Field, Notice, styles } from "./ui";

const MAX_PICKS = 64;

export function NewSession({ api, info, kind, back, open, connectionFault }: {
  api: MobileApi; info: ServerInfo; kind: ChatKind; back: () => void;
  open: (id: string, draft?: string, sendDraft?: boolean) => void; connectionFault: (error: unknown) => boolean;
}) {
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
  const canPick = kind === "practice" && hasCapability(info, PRACTICE_CONTROLS_V1);

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
        ...(kind === "practice" ? { kind, ...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}) } : {}),
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
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Graph material</Text>
          <Field label="Search propositions" value={query} onChangeText={setQuery} />
          <View style={styles.row}>
            <Button primary onPress={() => setPicking(false)}>{`Done (${picks.length})`}</Button>
            {!!graphError && <Button onPress={() => { setGraphError(""); setGraphRevision((n) => n + 1); }}>Retry</Button>}
          </View>
          <Notice>{graphError}</Notice>
        </View>
        <FlatList data={filtered} keyExtractor={({ id }) => id} keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.section} ListEmptyComponent={
            graphError ? undefined : <Text style={styles.muted}>{propositions ? "No matching propositions" : "Loading propositions…"}</Text>
          }
          renderItem={({ item }) => {
            const selected = picks.some(({ id }) => id === item.id);
            const disabled = !selected && picks.length >= MAX_PICKS;
            return (
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled }} disabled={disabled}
                onPress={() => setPicks((value) => selected ? value.filter(({ id }) => id !== item.id) : [...value, item])}
                style={[styles.card, selected && { backgroundColor: colors.accentLight, borderColor: colors.accent }]}>
                <Text style={styles.subtitle}>{item.name}</Text>
                <Text style={styles.text}>{item.statement}</Text>
              </Pressable>
            );
          }} />
      </>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.section} keyboardShouldPersistTaps="handled">
      <View style={styles.row}><Button disabled={busy} onPress={back}>Sessions</Button></View>
      <Text accessibilityRole="header" style={styles.title}>{kind === "practice" ? "New practice session" : "New teaching session"}</Text>
      <Field label={kind === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
        value={draft} onChangeText={setDraft} multiline editable={!busy} />
      {canPick && <View style={styles.row}>
        <Button disabled={busy} onPress={() => { setGraphError(""); setPicking(true); }}>
          {picks.length ? `Graph material (${picks.length})` : "Pick graph material"}
        </Button>
      </View>}
      {picks.length > 0 && <Text style={styles.muted}>{picks.map(({ name }) => name).join(", ")}</Text>}
      <Notice>{error}</Notice>
      {recent?.map((chat) => <Button key={chat.id} onPress={() => open(chat.id, draft.trim())}>{chat.title}</Button>)}
      <View style={styles.row}>
        <Button primary disabled={busy || !draft.trim() || (!!recent && recent.length > 0)} onPress={() => void create()}>
          {busy ? "Starting…" : "Start session"}
        </Button>
      </View>
    </ScrollView>
  );
}
