import { useEffect, useRef, useState, type RefObject, type ComponentRef } from "react";
import { Alert, Linking, ScrollView, Text, View } from "react-native";
import {
  BROWSER_HANDOFF_ROUTES, BROWSER_HANDOFF_V1, PRACTICE_CONTROLS_V1, hasCapability,
  type LhMessage, type PairingTokenResponse, type ServerInfo,
} from "../../../src/client-protocol/index.ts";
import { activeProblemOf, malformedQuestionsOf, pendingQuestionOf, pluginQuestionCallsOf } from "../../../src/core/native-messages.ts";
import { browserDestination, type MobileApi } from "./protocol";
import { errorText, useSession } from "./use-session";
import { BuiltinQuestion } from "./BuiltinQuestion";
import { Transcript } from "./Transcript";
import { Button, Field, Notice, styles } from "./ui";

const EMPTY: LhMessage[] = [];

export function Session({ api, info, id, initialText, sendInitialText, active, reloadRef, back, connectionFault }: {
  api: MobileApi; info: ServerInfo; id: string; initialText?: string; sendInitialText?: boolean; active: boolean;
  reloadRef: RefObject<((reconnect?: boolean) => void) | null>; back: () => void; connectionFault: (error: unknown) => boolean;
}) {
  const session = useSession(api, id, active, connectionFault);
  const { record } = session;
  const [draft, setDraft] = useState(initialText ?? "");
  const [browserError, setBrowserError] = useState("");
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const browserScope = useRef<AbortController | null>(null);
  const started = useRef(false);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const nearBottom = useRef(true);
  const messages = record?.messages ?? EMPTY;
  const problem = activeProblemOf(messages);
  const question = pendingQuestionOf(messages);
  const pluginQuestion = pluginQuestionCallsOf(messages).find(({ status }) => status === "answerable" || status === "unreadable");
  const malformed = malformedQuestionsOf(messages)[0];
  const practice = record?.kind === "practice";
  const controls = hasCapability(info, PRACTICE_CONTROLS_V1);
  const assisted = hasCapability(info, BROWSER_HANDOFF_V1);
  const pendingPlugin = !!(pluginQuestion || problem?.pluginProblem);
  const busy = !!record?.turnInFlight;
  const blocked = !active || !record || !!session.refreshError || session.unconfirmed || session.writing || session.stopping || !!record.compacting;
  const lastAssistant = messages.findLast((message) => message.role === "assistant");
  const failure = session.streamError || record?.turnError || (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage : "");
  const { refresh, submit } = session;

  useEffect(() => {
    reloadRef.current = refresh;
    return () => { reloadRef.current = null; browserScope.current?.abort(); };
  }, [refresh, reloadRef]);

  useEffect(() => {
    if (!sendInitialText || !initialText || started.current || blocked || busy || !record) return;
    started.current = true;
    // A created session can also be opened in another client before this
    // GET arrives. In that case leave the draft for the learner to review.
    if (record.messages.some((message) => message.role !== "custom")) return;
    void submit({ type: "text", text: initialText }, () => setDraft(""));
  }, [blocked, busy, initialText, record, sendInitialText, submit]);

  async function openBrowser(pair: boolean) {
    if (browserScope.current) return;
    const scope = new AbortController();
    browserScope.current = scope;
    setOpeningBrowser(true);
    setBrowserError("");
    try {
      const token = pair ? await api.post<PairingTokenResponse>(BROWSER_HANDOFF_ROUTES.pairingToken, {}, scope.signal) : undefined;
      if (scope.signal.aborted) return;
      if (pair && !token?.credential) throw new Error("Couldn't create a browser pairing code.");
      await Linking.openURL(browserDestination(api.origin, id, token?.credential));
    } catch (error) {
      if (!scope.signal.aborted && !connectionFault(error)) setBrowserError(pair ? errorText(error) : "Couldn't open the browser.");
    } finally {
      browserScope.current = null;
      if (!scope.signal.aborted) setOpeningBrowser(false);
    }
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    void submit(problem ? { type: "thinking", problemCallId: problem.toolCallId, text } : { type: "text", text },
      () => setDraft((current) => current.trim() === text ? "" : current));
  }

  function discard(problemCallId: string) {
    Alert.alert("Discard this problem?", "You can continue the session after discarding it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => void submit({ type: "dismiss-problem", problemCallId }, () => setDraft("")) },
    ]);
  }

  return (
    <>
      <View style={styles.header}>
        <View style={styles.row}>
          <Button onPress={back}>Sessions</Button>
          {busy && <Button primary onPress={() => void session.stop()} disabled={session.stopping}>{session.stopping ? "Stopping…" : "Stop"}</Button>}
        </View>
        <Text accessibilityRole="header" style={styles.title}>{record?.title ?? "Session"}</Text>
      </View>
      <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={styles.section}
        keyboardShouldPersistTaps="handled" scrollEventThrottle={100}
        onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => {
          nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
        }}
        onContentSizeChange={() => { if (nearBottom.current) scroller.current?.scrollToEnd({ animated: false }); }}>
        {session.loading && <Text style={styles.muted}>Loading session…</Text>}
        <Transcript messages={messages} tail={session.tail} api={api} chatId={id} />
        {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>Reply in progress…</Text>}
        {record?.compacting && <Text style={styles.muted}>Updating session context…</Text>}
        <Notice>{session.refreshError}</Notice>
        {!!session.refreshError && <Button onPress={() => refresh(true)}>Reconnect</Button>}
        <Notice>{session.writeError}</Notice>
        <Notice>{failure}</Notice>
        {failure && !busy && !pendingPlugin && (
          <Button disabled={blocked} onPress={() => void submit({ type: "retry" })}>Retry reply</Button>
        )}
        {question && !pendingPlugin && (
          <BuiltinQuestion key={question.key} question={question} disabled={blocked || busy} submit={(input) => void submit(input)} />
        )}
        {!question && !pendingPlugin && !malformed && record && (
          <View style={styles.card}>
            <Field label={problem ? "Your thinking" : "Message"} multiline value={draft} onChangeText={setDraft}
              editable={!blocked && !busy} />
            <View style={styles.row}>
              <Button primary disabled={blocked || busy || !draft.trim()} onPress={sendDraft}>{problem ? "Submit thinking" : "Send"}</Button>
              {practice && !problem && messages.length > 0 && !busy &&
                <Button disabled={blocked} onPress={() => void submit({ type: "next" })}>Next</Button>}
              {problem && controls && <Button disabled={blocked} onPress={() => discard(problem.toolCallId)}>Discard problem</Button>}
            </View>
          </View>
        )}
        {malformed && !question && !pendingPlugin && (
          <Button disabled={blocked || busy} onPress={() => void submit({
            type: "retry-question", messageId: malformed.messageId, contentIndex: malformed.contentIndex, toolCallId: malformed.toolCallId,
          })}>Retry question</Button>
        )}
        {record && (
          <View style={{ gap: 6 }}>
            {pendingPlugin && <Text style={styles.muted}>Use the browser to complete this interaction.</Text>}
            <Notice>{browserError}</Notice>
            <View style={styles.row}>
              <Button disabled={openingBrowser} onPress={() => void openBrowser(false)}>Open in browser</Button>
              {assisted && <Button disabled={openingBrowser} onPress={() => void openBrowser(true)}>Pair phone browser</Button>}
            </View>
          </View>
        )}
      </ScrollView>
    </>
  );
}
