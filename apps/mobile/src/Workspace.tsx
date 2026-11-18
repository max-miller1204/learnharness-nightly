import { useEffect, useRef, useState } from "react";
import { BackHandler, FlatList, Pressable, Text, View } from "react-native";
import { PROTOCOL_ROUTES, type ChatKind, type ChatListResponse, type ServerInfo } from "../../../src/client-protocol/index.ts";
import type { MobileApi } from "./protocol";
import { useEvents } from "./use-events";
import { errorText } from "./use-session";
import { NewSession } from "./NewSession";
import { Session } from "./Session";
import { Button, Notice, styles } from "./ui";

type Page = { type: "list" } | { type: "new"; kind: ChatKind } | { type: "session"; id: string; draft?: string; sendDraft?: boolean };

export function Workspace({ api, initialInfo, active, servers, connectionFault }: {
  api: MobileApi; initialInfo: ServerInfo; active: boolean; servers: () => void; connectionFault: (error: unknown) => boolean;
}) {
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
      {offline && <View style={{ padding: 8 }}><Notice>Live updates disconnected. Reconnecting…</Notice></View>}
      {page.type === "session" && <Session key={page.id} api={api} info={info} id={page.id} initialText={page.draft} sendInitialText={page.sendDraft}
        active={active} reloadRef={chatReload} back={back} connectionFault={connectionFault} />}
      {page.type === "new" && <NewSession api={api} info={info} kind={page.kind} back={back}
        open={(id, draft, sendDraft) => setPage({ type: "session", id, draft, sendDraft })} connectionFault={connectionFault} />}
      {listing && (
        <>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>LearnHarness Nightly</Text>
            <Text style={styles.muted}>{info.name} · {api.origin}</Text>
            <View style={styles.row}>
              <Button onPress={servers}>Servers</Button>
              <Button onPress={() => setPage({ type: "new", kind: "teach" })} primary>New teaching session</Button>
              <Button onPress={() => setPage({ type: "new", kind: "practice" })}>New practice session</Button>
            </View>
            <Notice>{listError}</Notice>
            {!!listError && <Button onPress={() => setRevision((value) => value + 1)}>Retry</Button>}
          </View>
          <FlatList data={chats} keyExtractor={({ id }) => id} contentContainerStyle={styles.section}
            onRefresh={() => setRevision((value) => value + 1)} refreshing={false}
            ListEmptyComponent={listError ? undefined : <Text style={styles.muted}>{chats ? "No sessions yet" : "Loading sessions…"}</Text>}
            renderItem={({ item }) => (
              <Pressable accessibilityRole="button" style={styles.card} onPress={() => setPage({ type: "session", id: item.id })}>
                <Text style={styles.subtitle}>{item.title}</Text>
                <Text style={styles.muted}>{item.kind === "practice" ? "Practice" : "Teaching"}{item.busy ? " · Reply in progress" : ""}</Text>
              </Pressable>
            )} />
        </>
      )}
    </>
  );
}
