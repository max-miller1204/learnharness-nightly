import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type ComponentRef } from "react";
import { Alert, Keyboard, Linking, Pressable, ScrollView, Text, TextInput, View, type NativeScrollEvent } from "react-native";
import {
  BROWSER_HANDOFF_ROUTES, BROWSER_HANDOFF_V1, LESSON_VIEW_V1, PRACTICE_CONTROLS_V1, hasCapability,
  type LhMessage, type PairingTokenResponse, type ServerInfo,
} from "../../../src/client-protocol/index.ts";
import { activeProblemOf, malformedQuestionsOf, pendingQuestionOf, pluginQuestionCallsOf } from "../../../src/core/native-messages.ts";
import { projectView } from "../../../src/core/view.ts";
import { browserDestination, type MobileApi } from "./protocol";
import { errorText, useSession } from "./use-session";
import { BuiltinQuestion } from "./BuiltinQuestion";
import { Transcript } from "./Transcript";
import { Button, Label, Notice } from "./ui";
import { fonts, radius, space, useTheme } from "./theme";
import { revealOffset } from "./reveal";
import { followsBottom, openSettle, pendingCounter } from "./open-settle";
import { MathLoading } from "./Markdown";
import { checkNeedsReveal, livePlan, PHASE_LABEL, sessionPhase, skipAnswer, skipParked } from "./lesson";
import { PlanScreen } from "./PlanScreen";
import { useJobs } from "./use-jobs";

const EMPTY: LhMessage[] = [];

/** One choice in the top bar's … menu. */
function MenuItem({ label, onPress, close, disabled = false }: { label: string; onPress: () => void; close: () => void; disabled?: boolean }) {
  const { c, s } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
      onPress={() => { close(); onPress(); }}
      style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: space.sm, borderRadius: radius.md, borderCurve: "continuous",
        backgroundColor: pressed ? c.hover : "transparent", opacity: disabled ? 0.5 : 1 })}>
      <Text style={s.ui}>{label}</Text>
    </Pressable>
  );
}

export function Session({ api, info, id, initialText, sendInitialText, active, reloadRef, jobsRef, back, connectionFault }: {
  api: MobileApi; info: ServerInfo; id: string; initialText?: string; sendInitialText?: boolean; active: boolean;
  reloadRef: RefObject<((reconnect?: boolean) => void) | null>; jobsRef: RefObject<(() => void) | null>;
  back: () => void; connectionFault: (error: unknown) => boolean;
}) {
  const { c, s } = useTheme();
  const session = useSession(api, id, active, connectionFault);
  const { record } = session;
  const [draft, setDraft] = useState(initialText ?? "");
  const [browserError, setBrowserError] = useState("");
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [barHeight, setBarHeight] = useState(60);
  const dock = useRef<ComponentRef<typeof ScrollView>>(null);
  const dockState = useRef({ offset: 0, viewport: 0 });
  const browserScope = useRef<AbortController | null>(null);
  const started = useRef(false);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const nearBottom = useRef(true);
  const userScrolling = useRef(false);
  const lastOffset = useRef(0);
  // On open the transcript stays hidden until its first layout settles at the bottom.
  const [opened, setOpened] = useState(false);
  const settling = useRef<ReturnType<typeof openSettle> | null>(null);
  const settleStarted = useRef(false);
  const messages = record?.messages ?? EMPTY;
  const problem = activeProblemOf(messages);
  const question = pendingQuestionOf(messages);
  const pluginQuestion = pluginQuestionCallsOf(messages).find(({ status }) => status === "answerable" || status === "unreadable");
  const malformed = malformedQuestionsOf(messages)[0];
  const practice = record?.kind === "practice";
  const controls = hasCapability(info, PRACTICE_CONTROLS_V1);
  const assisted = hasCapability(info, BROWSER_HANDOFF_V1);
  const lessonView = hasCapability(info, LESSON_VIEW_V1);
  const settledView = useMemo(() => projectView(messages), [messages]);
  const hasPlan = useMemo(() => livePlan(settledView) !== null, [settledView]);
  const reveal = !!question && checkNeedsReveal(question, messages);
  // A check that directly follows another question arrives open; one that
  // follows teaching, or is already waiting when the session opens, waits
  // closed (chat.tsx revealArrival).
  const questionKey = question?.key ?? null;
  const [arrival, setArrival] = useState({ key: null as string | null, open: false, seen: false });
  if (record && (arrival.key !== questionKey || !arrival.seen)) {
    setArrival({ key: questionKey, open: arrival.seen && arrival.key !== null && questionKey !== null, seen: true });
  }
  const pendingPlugin = !!(pluginQuestion || problem?.pluginProblem);
  const busy = !!record?.turnInFlight;
  const blocked = !active || !record || !!session.refreshError || session.unconfirmed || session.writing || session.stopping || !!record.compacting;
  const lastAssistant = messages.findLast((message) => message.role === "assistant");
  const failure = session.streamError || record?.turnError || (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage : "");
  const { refresh, submit } = session;
  const jobsSettled = useCallback(() => refresh(), [refresh]);
  const jobs = useJobs(api, id, active && lessonView, jobsRef, jobsSettled, connectionFault);

  const loaded = !!record;
  const hidden = loaded && !opened;
  // Math views still loading; the last one finishing restarts the quiet wait.
  const [math] = useState(() => pendingCounter(() => settling.current?.changed()));
  useEffect(() => () => settling.current?.cancel(), []);
  // The settle starts at the transcript's first real layout, not when the
  // record arrives: a long session can take longer to lay out than the quiet wait.
  function laidOut() {
    if (!settleStarted.current) {
      settleStarted.current = true;
      settling.current = openSettle(() => {
        settling.current = null;
        scroller.current?.scrollToEnd({ animated: false });
        nearBottom.current = true;
        setOpened(true);
      }, { loading: () => math.count > 0 });
    }
    pin();
  }
  // Content growth, or a shorter viewport when the question dock below grows,
  // keeps the transcript at the bottom while opening or already there.
  function scrolled({ contentOffset, layoutMeasurement, contentSize }: NativeScrollEvent, dragging: boolean) {
    const previousOffset = lastOffset.current;
    lastOffset.current = contentOffset.y;
    if (settling.current) return;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    nearBottom.current = followsBottom(nearBottom.current, { distance, offset: contentOffset.y, previousOffset, dragging });
  }
  function pin() {
    if (settling.current || nearBottom.current) scroller.current?.scrollToEnd({ animated: false });
    settling.current?.changed();
  }

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

  // The keyboard shrinks the question dock; keep the field being typed in on screen.
  // While a question is pending, the dock holds the only text fields on the screen.
  function revealFocusedField() {
    const input = TextInput.State.currentlyFocusedInput();
    const content = dock.current?.getInnerViewRef();
    if (!input || !content) return;
    input.measureLayout(content, (_x, y, _width, height) => {
      const target = revealOffset({ y, height }, dockState.current.viewport, dockState.current.offset);
      if (target !== null) dock.current?.scrollTo({ y: target, animated: true });
    }, () => {});
  }

  useEffect(() => {
    if (!question) return;
    const subscription = Keyboard.addListener("keyboardDidShow", () => requestAnimationFrame(revealFocusedField));
    return () => subscription.remove();
  }, [question]);

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

  function skip(readingThinking: string) {
    const target = question;
    if (!target) return;
    Alert.alert("Skip this question?", "The teacher moves on without it." + (busy ? " The teacher's current reply stops too." : ""), [
      { text: "Cancel", style: "cancel" },
      // Like the web, a skip the server parked for a running turn (202) also
      // stops that turn. The server's answer decides, not the dialog's moment,
      // and a failed follow-up stop never turns a saved skip into an error.
      { text: "Skip", onPress: () => void submit({ type: "dismiss", toolCallId: target.toolCallId, answer: skipAnswer(target, readingThinking) },
        (result) => { if (skipParked(result)) void session.stop(true); }) },
    ]);
  }

  function discard(problemCallId: string) {
    Alert.alert("Discard this problem?", "You can continue the session after discarding it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => void submit({ type: "dismiss-problem", problemCallId }, () => setDraft("")) },
    ]);
  }

  const thinkingLabel = problem ? "Your thinking" : "Message";
  // Browser handoff lives in the top bar's menu until the phone handles these flows itself.
  const close = () => setMenuOpen(false);
  return (
    <MathLoading.Provider value={math.begin}>
    <View style={{ flex: 1 }}>
      <View style={[s.bar, { zIndex: 2 }]} onLayout={({ nativeEvent }) => setBarHeight(nativeEvent.layout.height)}>
        <Button variant="ghost" label="Sessions" onPress={back} style={{ width: 36, paddingHorizontal: 0 }}>
          <Text style={[s.ui, { fontSize: 20, lineHeight: 24 }]}>‹</Text>
        </Button>
        <Text accessibilityRole="header" numberOfLines={1} style={[s.title, { flex: 1 }]}>{record?.title ?? "Session"}</Text>
        {practice ? <Label>Practice</Label> : record && <Label>{PHASE_LABEL[sessionPhase(messages)]}</Label>}
        {busy && <Button primary onPress={() => void session.stop()} disabled={session.stopping}>{session.stopping ? "Stopping…" : "Stop"}</Button>}
        {record && <Button variant="ghost" label="Session options" selected={false} onPress={() => setMenuOpen((open) => !open)}
          style={[{ width: 36, paddingHorizontal: 0 }, menuOpen && { backgroundColor: c.hover }]}>
          <Text style={[s.ui, { fontSize: 16 }]}>…</Text>
        </Button>}
      </View>
      {hidden && (
        <View pointerEvents="none" style={[s.section, { position: "absolute", top: barHeight, left: 0, right: 0 }]}>
          <Text style={s.muted}>Loading session…</Text>
        </View>
      )}
      <ScrollView ref={scroller} style={{ flex: 1, opacity: hidden ? 0 : 1 }} contentContainerStyle={[s.section, { gap: space.lg }]}
        pointerEvents={hidden ? "none" : "auto"} accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        keyboardShouldPersistTaps="handled" scrollEventThrottle={100} onLayout={pin} onContentSizeChange={pin}
        onScrollBeginDrag={() => { userScrolling.current = true; }} onMomentumScrollBegin={() => { userScrolling.current = true; }}
        // The last scroll event of a fling can be dropped, so the ends check again.
        onScrollEndDrag={({ nativeEvent }) => { scrolled(nativeEvent, true); userScrolling.current = false; }}
        onMomentumScrollEnd={({ nativeEvent }) => { scrolled(nativeEvent, true); userScrolling.current = false; }}
        onScroll={({ nativeEvent }) => scrolled(nativeEvent, userScrolling.current)}>
        {session.loading && <Text style={s.muted}>Loading session…</Text>}
        <Transcript settled={settledView} tail={session.tail} api={api} chatId={id} jobs={jobs} liveHelpers={lessonView} openPlan={() => setPlanOpen(true)} />
        {busy && <Text accessibilityLiveRegion="polite" style={s.muted}>Reply in progress…</Text>}
        {record?.compacting && <Text style={s.muted}>Updating session context…</Text>}
        <Notice boxed>{session.refreshError}</Notice>
        {!!session.refreshError && <View style={s.row}><Button onPress={() => refresh(true)}>Reconnect</Button></View>}
        <Notice boxed>{session.writeError}</Notice>
        <Notice boxed>{failure}</Notice>
        {failure && !busy && !pendingPlugin && (
          <View style={s.row}><Button disabled={blocked} onPress={() => void submit({ type: "retry" })}>Retry reply</Button></View>
        )}
        {malformed && !question && !pendingPlugin && (
          <View style={s.row}><Button disabled={blocked || busy} onPress={() => void submit({
            type: "retry-question", messageId: malformed.messageId, contentIndex: malformed.contentIndex, toolCallId: malformed.toolCallId,
          })}>Retry question</Button></View>
        )}
        {record && pendingPlugin && <Text style={s.muted}>Use the browser to complete this interaction. Open it from the … menu above.</Text>}
        <Notice>{browserError}</Notice>
        {/* Pinned to the content's bottom edge, so it moves whenever anything above it grows:
            the open settle's layout signal. Absolute, so it adds no gap. */}
        {loaded && <View pointerEvents="none" onLayout={laidOut} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 0 }} />}
      </ScrollView>
      {question && !pendingPlugin && (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.md, maxHeight: "55%" }}>
          <View style={[s.dock, { flexShrink: 1, overflow: "hidden" }]}>
            <ScrollView ref={dock} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg }} scrollEventThrottle={16}
              onScroll={({ nativeEvent }) => { dockState.current.offset = nativeEvent.contentOffset.y; }}
              onLayout={({ nativeEvent }) => {
                const shrank = nativeEvent.layout.height < dockState.current.viewport;
                dockState.current.viewport = nativeEvent.layout.height;
                if (shrank) revealFocusedField();
              }}>
              <BuiltinQuestion key={question.key} question={question} disabled={blocked || busy} submit={(input) => void submit(input)}
                reveal={reveal} openAtStart={arrival.key === question.key && arrival.open}
                skip={lessonView ? { disabled: blocked, run: skip } : undefined} />
            </ScrollView>
          </View>
        </View>
      )}
      {!question && !pendingPlugin && !malformed && record && (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm }}>
          {((practice && !problem && messages.length > 0 && !busy) || (problem && controls)) && (
            <View style={s.row}>
              {practice && !problem && messages.length > 0 && !busy &&
                <Button variant="success" label="Next" disabled={blocked} onPress={() => void submit({ type: "next" })}>
                  <Text style={{ fontFamily: fonts.uiMedium, fontSize: 11, letterSpacing: 0.6, color: c.onPrimary }}>NEXT PROBLEM →</Text>
                </Button>}
              {problem && controls && <Button disabled={blocked} onPress={() => discard(problem.toolCallId)}>Discard problem</Button>}
            </View>
          )}
          <View style={s.dock}>
            {problem && <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><Label>Your thinking</Label></View>}
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 6 }}>
              <TextInput accessibilityLabel={thinkingLabel} placeholder={thinkingLabel} placeholderTextColor={c.muted} selectionColor={c.accent}
                multiline value={draft} onChangeText={setDraft} editable={!blocked && !busy}
                style={{ flex: 1, minHeight: 40, maxHeight: 192, paddingHorizontal: 10, paddingVertical: 10, fontFamily: fonts.prose, fontSize: 16, lineHeight: 20, color: c.text, textAlignVertical: "top" }} />
              <Button primary label={problem ? "Submit thinking" : "Send"} disabled={blocked || busy || !draft.trim()} onPress={sendDraft}
                style={{ width: 40, paddingHorizontal: 0, borderRadius: radius.control }}>
                <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: c.onPrimary }}>↵</Text>
              </Button>
            </View>
          </View>
        </View>
      )}
      {menuOpen && <Pressable accessibilityLabel="Close menu" onPress={() => setMenuOpen(false)}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 }} />}
      {/* A child of the full-height screen, not of the bar: Android's accessibility tree
          clips views to their parent's bounds, so a menu hanging below the bar had none. */}
      {menuOpen && record && (
        <View style={{ position: "absolute", top: barHeight + space.xs, right: space.md, zIndex: 3, minWidth: 200, padding: space.xs,
          borderRadius: radius.lg, borderCurve: "continuous", borderWidth: 1, borderColor: c.border, backgroundColor: c.card,
          boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.25)" }}>
          {hasPlan && <MenuItem label="View plan" close={close} onPress={() => setPlanOpen(true)} />}
          <MenuItem label="Open in browser" close={close} disabled={openingBrowser} onPress={() => void openBrowser(false)} />
          {assisted && <MenuItem label="Pair phone browser" close={close} disabled={openingBrowser} onPress={() => void openBrowser(true)} />}
        </View>
      )}
      {/* Over the session, not instead of it, so the transcript keeps its place. */}
      {planOpen && (
        <View style={[s.page, { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 4 }]}>
          <PlanScreen messages={settledView} close={() => setPlanOpen(false)} />
        </View>
      )}
    </View>
    </MathLoading.Provider>
  );
}
