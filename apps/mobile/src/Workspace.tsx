import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, BackHandler, FlatList, Keyboard, Platform, Pressable, Text, View } from "react-native";
import { PROTOCOL_ROUTES, type ChatListItem, type ChatListResponse, type ServerInfo } from "../../../src/client-protocol/index.ts";
import type { MobileApi } from "./protocol";
import { loadKindFilter, saveKindFilter } from "./device-storage";
import { RENAME_FAILED, renameSession } from "./session-actions";
import { shareSessionMarkdown } from "./session-export";
import { emptyListText, sessionActions, shownSessions, type SessionAction, type SessionKindFilter } from "./session-list";
import { DeleteBox, KindSwitch, RenameBox, SearchField, SessionRow } from "./SessionList";
import { freshView, workspaceView, type Page } from "./workspace-view";
import { useEvents } from "./use-events";
import { errorText } from "./use-session";
import { NewSession } from "./NewSession";
import { Session } from "./Session";
import { Button, Label, Notice } from "./ui";
import { radius, space, useTheme } from "./theme";

/** The web sidebar's quiet uppercase link (new session, settings). */
function SideLink({ children, label, onPress }: { children: string; label?: string; onPress: () => void }) {
  const { c, s } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.md, borderCurve: "continuous", backgroundColor: pressed ? c.hover : "transparent" })}>
      {({ pressed }) => <Text style={[s.label, { letterSpacing: 0.6 }, pressed && { color: c.text }]}>{children}</Text>}
    </Pressable>
  );
}

export function Workspace({ api, initialInfo, active, servers, connectionFault }: {
  api: MobileApi; initialInfo: ServerInfo; active: boolean; servers: () => void; connectionFault: (error: unknown) => boolean;
}) {
  const { s } = useTheme();
  const [{ page, query }, dispatch] = useReducer(workspaceView, undefined, freshView);
  const setPage = (next: Page) => dispatch({ type: "open", page: next });
  const [chats, setChats] = useState<ChatListResponse["chats"]>();
  const [listError, setListError] = useState("");
  const [revision, setRevision] = useState(0);
  const [info, setInfo] = useState(initialInfo);
  const [offline, setOffline] = useState(false);
  const chatReload = useRef<((reconnect?: boolean) => void) | null>(null);
  const jobsReload = useRef<(() => void) | null>(null);
  const [kind, setKind] = useState<SessionKindFilter>("all");
  const [renaming, setRenaming] = useState<ChatListItem>();
  const [deleting, setDeleting] = useState<ChatListItem>();
  const exporting = useRef(false);
  const kindChosen = useRef(false);
  const lifetime = useRef(new AbortController());
  const listing = page.type === "list";
  const back = () => dispatch({ type: "back" });
  const shown = useMemo(() => chats && shownSessions(chats, query, kind), [chats, query, kind]);
  const actions = sessionActions(info);

  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    void loadKindFilter().then((stored) => { if (!scope.signal.aborted && !kindChosen.current) setKind(stored); }).catch(() => {});
    return () => scope.abort();
  }, []);

  function chooseKind(next: SessionKindFilter) {
    kindChosen.current = true;
    setKind(next);
    void saveKindFilter(next).catch(() => {});
  }

  function patchTitle(id: string, title: string) {
    setChats((list) => list?.map((chat) => chat.id === id ? { ...chat, title } : chat));
  }

  async function commitRename(chat: ChatListItem, value: string) {
    setRenaming(undefined);
    const outcome = await renameSession(api, chat.id, chat.title, value, lifetime.current.signal);
    if (lifetime.current.signal.aborted) return;
    if (outcome.kind === "renamed") patchTitle(chat.id, outcome.title);
    else if (outcome.kind === "failed" && !connectionFault(outcome.error)) Alert.alert(RENAME_FAILED, outcome.message);
  }

  async function exportChat(chat: ChatListItem) {
    if (exporting.current) return;
    exporting.current = true;
    try {
      await shareSessionMarkdown(api, chat.id, lifetime.current.signal);
    } catch (error) {
      if (!lifetime.current.signal.aborted && !connectionFault(error)) Alert.alert("Could not export session", errorText(error));
    } finally {
      exporting.current = false;
    }
  }

  function act(chat: ChatListItem, action: SessionAction) {
    if (action === "export") return void exportChat(chat);
    if (action === "delete") return setDeleting(chat);
    if (Platform.OS === "ios") {
      Alert.prompt("Rename session", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Rename", onPress: (value?: string) => void commitRename(chat, value ?? "") },
      ], "plain-text", chat.title);
    } else {
      setRenaming(chat);
    }
  }

  useEffect(() => {
    if (listing) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => subscription.remove();
  }, [listing]);

  useEvents(api, active, (frame) => {
    if (!frame) {
      if (listing) setRevision((value) => value + 1);
      chatReload.current?.(true);
      jobsReload.current?.();
      return;
    }
    switch (frame.event) {
      case "chats-changed":
        if (listing) setRevision((value) => value + 1);
        // Carries no chat ID: reread the open session in case it was deleted.
        if (page.type === "session") chatReload.current?.();
        break;
      case "turn-started":
      case "turn-settled":
      case "record-changed":
      case "compaction-changed":
        if (listing) setRevision((value) => value + 1);
        if (page.type === "session" && "chatId" in frame.data && frame.data.chatId === page.id) chatReload.current?.();
        break;
      case "jobs-changed":
        if (page.type === "session" && (frame.data.chatId == null || frame.data.chatId === page.id)) jobsReload.current?.();
        break;
      case "plugins-changed":
        chatReload.current?.();
        break;
    }
  }, connectionFault, setOffline, setInfo);

  useEffect(() => {
    if (!active || !listing) return;
    const scope = new AbortController();
    api.get<ChatListResponse>(PROTOCOL_ROUTES.chats, scope.signal).then(({ chats }) => {
      if (!scope.signal.aborted) { setChats(chats); setListError(""); }
    }).catch((error) => {
      if (!scope.signal.aborted && !connectionFault(error)) setListError(errorText(error));
    });
    return () => scope.abort();
  }, [active, api, connectionFault, listing, revision]);

  return (
    <>
      {offline && <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}><Notice>Live updates disconnected. Reconnecting…</Notice></View>}
      {page.type === "session" && <Session key={page.id} api={api} info={info} id={page.id} initialText={page.draft} sendInitialText={page.sendDraft}
        active={active} reloadRef={chatReload} jobsRef={jobsReload} back={back} connectionFault={connectionFault} />}
      {page.type === "new" && <NewSession api={api} info={info} kind={page.kind} back={back}
        open={(id, draft, sendDraft) => setPage({ type: "session", id, draft, sendDraft })} connectionFault={connectionFault} />}
      {listing && (
        <FlatList data={shown} keyExtractor={({ id }) => id} contentContainerStyle={{ padding: space.sm, paddingBottom: space.xl }}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          onRefresh={() => setRevision((value) => value + 1)} refreshing={false}
          ListHeaderComponent={
            <View style={{ gap: space.md, paddingBottom: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingLeft: space.md, paddingTop: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Text accessibilityRole="header" style={s.heading}>LearnHarness Nightly</Text>
                  <Text selectable numberOfLines={1} style={s.meta}>{info.name} · {api.origin}</Text>
                </View>
                <SideLink label="Servers" onPress={servers}>Servers</SideLink>
              </View>
              <View>
                <SideLink label="New teaching session" onPress={() => setPage({ type: "new", kind: "teach" })}>+ Teaching</SideLink>
                <SideLink label="New practice session" onPress={() => setPage({ type: "new", kind: "practice" })}>+ Practice</SideLink>
              </View>
              <View style={{ gap: space.sm, paddingHorizontal: space.md }}>
                <Label>Sessions</Label>
                <SearchField value={query} onChange={(next) => dispatch({ type: "search", query: next })} />
                <KindSwitch value={kind} onChange={chooseKind} />
              </View>
              {!!listError && <View style={{ gap: space.sm, paddingHorizontal: space.md }}>
                <Notice>{listError}</Notice>
                <View style={s.row}><Button onPress={() => setRevision((value) => value + 1)}>Retry</Button></View>
              </View>}
            </View>
          }
          ListEmptyComponent={listError ? undefined : <Text style={[s.meta, { paddingHorizontal: space.md, paddingVertical: space.lg }]}>{emptyListText(query, !!chats)}</Text>}
          renderItem={({ item }) => (
            <SessionRow chat={item} actions={actions} onAction={(action) => act(item, action)}
              onOpen={() => { Keyboard.dismiss(); setPage({ type: "session", id: item.id }); }} />
          )} />
      )}
      {renaming && <RenameBox title={renaming.title} onCancel={() => setRenaming(undefined)} onRename={(value) => void commitRename(renaming, value)} />}
      {deleting && <DeleteBox key={deleting.id} api={api} chat={deleting} connectionFault={connectionFault} onClose={() => setDeleting(undefined)}
        onDeleted={(id) => { setDeleting(undefined); setChats((list) => list?.filter((chat) => chat.id !== id)); }} />}
    </>
  );
}
