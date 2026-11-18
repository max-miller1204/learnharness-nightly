import { useEffect, useRef, useState } from "react";
import { BackHandler, FlatList, Pressable, Text, View } from "react-native";
import { PROTOCOL_ROUTES, type ChatKind, type ChatListResponse, type ServerInfo } from "../../../src/client-protocol/index.ts";
import type { MobileApi } from "./protocol";
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

type Page = { type: "list" } | { type: "new"; kind: ChatKind } | { type: "session"; id: string; draft?: string; sendDraft?: boolean };

export function Workspace({ api, initialInfo, active, servers, connectionFault }: {
  api: MobileApi; initialInfo: ServerInfo; active: boolean; servers: () => void; connectionFault: (error: unknown) => boolean;
}) {
  const { c, s } = useTheme();
  const [page, setPage] = useState<Page>({ type: "list" });
  const [chats, setChats] = useState<ChatListResponse["chats"]>();
  const [listError, setListError] = useState("");
  const [revision, setRevision] = useState(0);
  const [info, setInfo] = useState(initialInfo);
  const [offline, setOffline] = useState(false);
  const chatReload = useRef<((reconnect?: boolean) => void) | null>(null);
  const listing = page.type === "list";
  const back = () => setPage({ type: "list" });

  useEffect(() => {
    if (listing) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => subscription.remove();
  }, [listing]);

  useEvents(api, active, (frame) => {
    if (!frame) {
      if (listing) setRevision((value) => value + 1);
      chatReload.current?.(true);
      return;
    }
    switch (frame.event) {
      case "chats-changed":
      case "turn-started":
      case "turn-settled":
      case "record-changed":
      case "compaction-changed":
        if (listing) setRevision((value) => value + 1);
        if (page.type === "session" && "chatId" in frame.data && frame.data.chatId === page.id) chatReload.current?.();
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
        active={active} reloadRef={chatReload} back={back} connectionFault={connectionFault} />}
      {page.type === "new" && <NewSession api={api} info={info} kind={page.kind} back={back}
        open={(id, draft, sendDraft) => setPage({ type: "session", id, draft, sendDraft })} connectionFault={connectionFault} />}
      {listing && (
        <FlatList data={chats} keyExtractor={({ id }) => id} contentContainerStyle={{ padding: space.sm, paddingBottom: space.xl }}
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
              <View style={{ paddingHorizontal: space.md }}><Label>Sessions</Label></View>
              {!!listError && <View style={{ gap: space.sm, paddingHorizontal: space.md }}>
                <Notice>{listError}</Notice>
                <View style={s.row}><Button onPress={() => setRevision((value) => value + 1)}>Retry</Button></View>
              </View>}
            </View>
          }
          ListEmptyComponent={listError ? undefined : <Text style={[s.meta, { paddingHorizontal: space.md, paddingVertical: space.lg }]}>{chats ? "No sessions yet" : "Loading sessions…"}</Text>}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => setPage({ type: "session", id: item.id })}
              style={({ pressed }) => ({ marginBottom: 2, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: pressed ? c.hover : "transparent" })}>
              <Text numberOfLines={1} style={s.prose}>{item.title}</Text>
              <Text style={s.meta}>{item.kind === "practice" ? "Practice" : "Teaching"}{item.busy ? " · Reply in progress" : ""}</Text>
            </Pressable>
          )} />
      )}
    </>
  );
}
