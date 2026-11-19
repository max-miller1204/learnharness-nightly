// First-task spike for docs/specs/mobile-session-open.md, shown in place of the app when
// EXPO_PUBLIC_SESSION_OPEN_SPIKE=1. It opens the made-up sessions in
// tests/fixtures/mobile-session-open/ with the real transcript and logs to logcat
// ("[OpenSpike]" lines). It is removed once the feature is built.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, LogBox, ScrollView, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { ChatResponse, LhMessage } from "../../../src/client-protocol/index.ts";
import { projectView } from "../../../src/core/view.ts";
import longChat from "../../../tests/fixtures/mobile-session-open/chats/chat_zzopenlong.json";
import shortChat from "../../../tests/fixtures/mobile-session-open/chats/chat_zzopenshort.json";
import plainChat from "../../../tests/fixtures/mobile-session-open/chats/chat_zzopenplain.json";
import mathChat from "../../../tests/fixtures/mobile-session-open/chats/chat_zzopenmath.json";
import { cachedEquations, drawCount, drawEquation, equationsIn, isDrawn } from "./message-math";
import { speak, startSpeech } from "./math-speech";
import type { MobileApi } from "./protocol";
import { SLICE_MS, useSessionOpening, type OpeningTrace } from "./session-open";
import { markdownTexts, Transcript } from "./Transcript";
import { Button } from "./ui";
import { space, useTheme } from "./theme";

LogBox.ignoreAllLogs(true);

const log = (line: string) => console.log(`[OpenSpike] ${line}`);
const now = () => performance.now();
const round = (value: number) => Math.round(value * 10) / 10;

type Mode = "plain" | "scroll-up" | "top";
interface Choice { key: string; label: string; chat: unknown; mode: Mode }
const CHOICES: Choice[] = [
  { key: "long", label: "Long session", chat: longChat, mode: "plain" },
  { key: "long-up", label: "Long, scroll up 600 px when shown", chat: longChat, mode: "scroll-up" },
  { key: "long-top", label: "Long, jump to top when shown", chat: longChat, mode: "top" },
  { key: "short", label: "Short session", chat: shortChat, mode: "plain" },
  { key: "plain", label: "Session without math", chat: plainChat, mode: "plain" },
  { key: "math", label: "Math cases", chat: mathChat, mode: "plain" },
];

const engine = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === "object" ? "Hermes" : "not Hermes";
const NO_API = {} as MobileApi;
const EMPTY: LhMessage[] = [];

export function SessionOpenSpike() {
  const { s } = useTheme();
  const [open, setOpen] = useState<{ choice: Choice; tappedAt: number; run: number }>();
  const runs = useRef(0);
  const [note, setNote] = useState("");
  useEffect(() => log(`spike ready engine=${engine} dev=${__DEV__} slice=${SLICE_MS}ms`), []);
  if (open) return <SpikeSession key={open.run} {...open} back={() => setOpen(undefined)} />;
  return (
    <ScrollView contentContainerStyle={[s.section, { gap: space.md }]}>
      <Text accessibilityRole="header" style={s.title}>Session open spike</Text>
      <Text style={s.muted}>Engine: {engine}. Each open is a fresh run; equations already drawn stay cached until the app restarts.</Text>
      {CHOICES.map((choice) => (
        <Button key={choice.key} onPress={() => {
          const tappedAt = now();
          runs.current++;
          log(`tap ${choice.key} run=${runs.current} cachedEquations=${cachedEquations()}`);
          setOpen({ choice, tappedAt, run: runs.current });
        }}>{choice.label}</Button>
      ))}
      <Button onPress={() => void timeSpeech(setNote)}>Time spoken math</Button>
      {!!note && <Text selectable style={s.ui}>{note}</Text>}
    </ScrollView>
  );
}

/** Times the speech engine's start and how long it takes to speak the long session's last message. */
async function timeSpeech(setNote: (note: string) => void) {
  const view = projectView((longChat as unknown as ChatResponse).messages);
  const equations = markdownTexts(view.at(-1)!).flatMap(equationsIn);
  const distinct = [...new Map(equations.map((equation) => [`${equation.display}${equation.tex}`, equation])).values()];
  const began = now();
  try { await startSpeech(); } catch (error) { setNote(`speech failed: ${String(error)}`); return; }
  const started = now() - began;
  const spoken = now();
  for (const equation of distinct) {
    const drawn = drawEquation(equation);
    if (drawn) speak(drawn.mathml);
  }
  const line = `speech start=${Math.round(started)}ms; spoke ${distinct.length} distinct equations in ${Math.round(now() - spoken)}ms (${round((now() - spoken) / distinct.length)}ms each, drawing included when not cached)`;
  log(line);
  setNote(line);
}

function SpikeSession({ choice, tappedAt, back }: { choice: Choice; tappedAt: number; back: () => void }) {
  const { s } = useTheme();
  const record = choice.chat as unknown as ChatResponse;
  const settled = useMemo(() => projectView(record.messages), [record]);
  const stats = useRef({ shownAt: 0, steps: 0, stepMsMax: 0, commitMsMax: 0, stallMax: 0, resizesAfterShown: 0, drawsAtTap: drawCount(), fillDoneAt: 0, anchors: [] as string[] });
  const layouts = useRef(new Map<string, { y: number; height: number }>());
  const offset = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const shownRef = useRef(false);

  // The record arrives a tick after the tap, as a fetched one would.
  useEffect(() => { const timer = setTimeout(() => setLoaded(true), 0); return () => clearTimeout(timer); }, []);

  const trace = useCallback<OpeningTrace>((event, data) => {
    const at = round(now() - tappedAt);
    if (event === "step") {
      stats.current.steps++;
      stats.current.stepMsMax = Math.max(stats.current.stepMsMax, data.ms as number);
    }
    if (event === "commit") stats.current.commitMsMax = Math.max(stats.current.commitMsMax, data.ms as number);
    if (event === "shown") {
      stats.current.shownAt = at;
      shownRef.current = true;
    }
    if (event !== "content" || !shownRef.current) log(`+${at}ms ${event} ${JSON.stringify(data)}`);
  }, [tappedAt]);

  const opening = useSessionOpening(settled, loaded, trace);

  // The longest gap between 16 ms ticks: how long the JS thread was held (Back waits that long).
  useEffect(() => {
    let last = now();
    const timer = setInterval(() => {
      const gap = now() - last;
      last = now();
      if (gap > stats.current.stallMax) stats.current.stallMax = gap;
    }, 16);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { log(`back (hardware) +${round(now() - tappedAt)}ms`); back(); return true; });
    return () => subscription.remove();
  }, [back, tappedAt]);

  /** The first message on screen and how far it sits below the top of the transcript. */
  const anchor = useCallback(() => {
    let best: { id: string; y: number } | undefined;
    for (const [id, { y, height }] of layouts.current) {
      if (y + height > offset.current && (!best || y < best.y)) best = { id, y };
    }
    return best && `${best.id}@${round(best.y - offset.current)}`;
  }, []);

  // At each step after showing, note the on-screen anchor once the step has laid out.
  useEffect(() => {
    if (!opening.shown) return;
    const timer = setTimeout(() => {
      const where = anchor();
      if (where) {
        stats.current.anchors.push(where);
        log(`+${round(now() - tappedAt)}ms anchor from=${opening.from} ${where} offset=${round(offset.current)}`);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [opening.from, opening.shown, anchor, tappedAt]);

  // What the checker drives: scroll away during the fill.
  useEffect(() => {
    if (!opening.shown) return;
    if (choice.mode === "scroll-up") opening.scrollProps.ref.current?.scrollTo({ y: Math.max(0, offset.current - 600), animated: false });
    if (choice.mode === "top") opening.scrollProps.ref.current?.scrollTo({ y: 0, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening.shown]);

  // The result, once every message is in and has had time to settle.
  useEffect(() => {
    if (!opening.shown || opening.from > 0) return;
    stats.current.fillDoneAt = round(now() - tappedAt);
    const timer = setTimeout(() => {
      const equations = settled.flatMap((message) => markdownTexts(message).flatMap(equationsIn));
      const latest = markdownTexts(settled.at(-1)!).flatMap(equationsIn);
      const byAnchor = new Map<string, Set<string>>();
      for (const entry of stats.current.anchors) {
        const [id = "", at = ""] = entry.split("@");
        byAnchor.set(id, (byAnchor.get(id) ?? new Set()).add(at));
      }
      const anchorMoves = [...byAnchor.entries()].filter(([, positions]) => positions.size > 1).map(([id, positions]) => `${id}:${[...positions].join("/")}`);
      const { shownAt, steps, stepMsMax, commitMsMax, stallMax, resizesAfterShown, drawsAtTap, fillDoneAt } = stats.current;
      log(`RESULT fixture=${choice.key} engine=${engine} dev=${__DEV__} tapToShownMs=${shownAt} fillDoneMs=${fillDoneAt}`
        + ` messages=${settled.length} equations=${equations.length} latestEquations=${latest.length} latestAllDrawn=${latest.every(isDrawn)}`
        + ` drawnThisRun=${drawCount() - drawsAtTap} steps=${steps} stepMsMax=${stepMsMax} commitMsMax=${commitMsMax} jsStallMaxMs=${Math.round(stallMax)}`
        + ` resizesAfterShown=${resizesAfterShown} anchorMoves=${anchorMoves.length ? anchorMoves.join(",") : "none"}`);
    }, 600);
    return () => clearTimeout(timer);
  }, [opening.shown, opening.from, settled, choice.key, tappedAt]);

  const onMessageLayout = useCallback((id: string, { nativeEvent: { layout } }: LayoutChangeEvent) => {
    const before = layouts.current.get(id);
    layouts.current.set(id, { y: layout.y, height: layout.height });
    // A message that changes height after its first layout was drawn late.
    if (before && Math.abs(before.height - layout.height) > 0.5) {
      if (shownRef.current) stats.current.resizesAfterShown++;
      log(`+${round(now() - tappedAt)}ms RESIZE ${id} ${round(before.height)}->${round(layout.height)} shown=${shownRef.current}`);
    }
  }, [tappedAt]);

  const { onScroll, ...scrollProps } = opening.scrollProps;
  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Button variant="ghost" label="Sessions" onPress={() => { log(`back (button) +${round(now() - tappedAt)}ms`); back(); }} style={{ width: 36, paddingHorizontal: 0 }}>
          <Text style={[s.ui, { fontSize: 20, lineHeight: 24 }]}>‹</Text>
        </Button>
        <Text accessibilityRole="header" numberOfLines={1} style={[s.title, { flex: 1 }]}>{record.title}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <ScrollView {...scrollProps} style={{ flex: 1, opacity: opening.shown ? 1 : 0 }} contentContainerStyle={[s.section, { gap: space.lg }]}
          importantForAccessibility={opening.shown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!opening.shown}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => { offset.current = event.nativeEvent.contentOffset.y; onScroll(event); }}>
          <Transcript settled={settled} from={opening.from} tail={EMPTY} api={NO_API} chatId={record.id} jobs={[]} liveHelpers={false} openPlan={() => {}}
            files={new Map()} unavailableFiles={new Set()} onMessageLayout={onMessageLayout} />
        </ScrollView>
        {!opening.shown && (
          <View style={[s.section, { position: "absolute", top: 0, left: 0, right: 0 }]}>
            <Text style={s.muted}>Loading session…</Text>
          </View>
        )}
      </View>
    </View>
  );
}
