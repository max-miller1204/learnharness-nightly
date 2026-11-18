import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Pressable, Text, View } from "react-native";
import Svg, { Line } from "react-native-svg";
import type { JobKind, JobRecord } from "../../../src/client-protocol/index.ts";
import {
  isSubagentFailure, isWebSourceUrl, type PdfResult, type ResearchResult, type SubagentArtifactData,
} from "../../../src/core/contracts/jobs.ts";
import { isModelsRefusal, isProviderKeyRefusal } from "../../../src/core/settings.ts";
import type { PluginBackgroundResult } from "../../../src/core/plugin-workers.ts";
import type { LhViewMessage } from "../../../src/core/view.ts";
import { elapsedSeconds, jobLabel } from "./lesson";
import { confirmExternalLink, Markdown } from "./Markdown";
import { Label } from "./ui";
import { alpha, fonts, radius, space, useTheme } from "./theme";

/** A collapsible row in the small uppercase register: label, then the chevron. */
function Disclosure({ heading, open, onToggle, children }: {
  heading: ReactNode; open: boolean; onToggle: () => void; children?: ReactNode;
}) {
  const { s } = useTheme();
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {heading}
        <Text style={[s.label, { fontSize: 14 }]}>{open ? "⌃" : "⌄"}</Text>
      </Pressable>
      {open && children}
    </View>
  );
}

/** The teacher's reasoning (ai-elements/reasoning.tsx): collapsed by default,
 * opening is always the learner's tap. While it streams, the row says THINKING…. */
export function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const heading = streaming
    ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><ActivityIndicator size="small" color={c.muted} /><Text style={s.label}>Thinking…</Text></View>
    : <Text style={s.label}>Agent’s thinking</Text>;
  return (
    <Disclosure heading={heading} open={open} onToggle={() => setOpen((value) => !value)}>
      {!!text && <View style={{ marginTop: space.md, opacity: 0.7 }}><Markdown text={text} /></View>}
    </Disclosure>
  );
}

/** The learner's own thinking (components/thinking-block.tsx): the band and
 * rail of their messages, the text in 50% italics. Transcript rows start open. */
export function ThinkingRow({ label, text, inCard }: { label: string; text: string; inCard?: boolean }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(true);
  return (
    <View style={[s.band, inCard && { backgroundColor: "transparent" }]}>
      <Disclosure heading={<Text style={s.label}>{label}</Text>} open={open} onToggle={() => setOpen((value) => !value)}>
        <Text selectable style={[s.prose, { fontFamily: fonts.proseItalic, fontSize: 15, color: alpha(c.text, 0.5), marginTop: 6 }]}>{text}</Text>
      </Disclosure>
    </View>
  );
}

/** The dotted rule with a centered chip (phase-divider.tsx and the compaction cut). */
export function SeamDivider({ label }: { label: string }) {
  const { c, s } = useTheme();
  const dots = <Svg height={2} style={{ flex: 1 }}><Line x1={0} y1={1} x2="100%" y2={1} stroke={alpha(c.border, 0.5)} strokeWidth={2} strokeDasharray="2 2" /></Svg>;
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginVertical: space.lg }}>
      {dots}
      <View style={{ borderWidth: 1, borderColor: alpha(c.border, 0.8), borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 }}>
        <Text style={s.label}>{label}</Text>
      </View>
      {dots}
    </View>
  );
}

/** compaction-divider.tsx: the quiet note where history was summarized, and the cut. */
export function CompactionNote() {
  const { c, s } = useTheme();
  return <Text style={[s.meta, { textAlign: "center", color: alpha(c.muted, 0.7) }]}>Context compacted</Text>;
}

export function CompactionCut({ tokensBefore }: { tokensBefore?: number }) {
  return <SeamDivider label={`History compacted${tokensBefore && tokensBefore > 0 ? ` · ${Math.round(tokensBefore / 1000)}k tok` : ""}`} />;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** graph-context-card.tsx: the session's graph picks, folded by default. */
export function GraphContextCard({ data }: { data?: { propositions?: { id: string; name: string; statement: string }[]; chains?: string[] } }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const propositions = data?.propositions ?? [];
  const chains = data?.chains ?? [];
  const dashed = { borderWidth: 1, borderStyle: "dashed" as const, borderColor: alpha(c.border, 0.7), borderRadius: radius.md };
  return (
    <View style={{ gap: space.xs }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}
        style={[dashed, { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm }]}>
        <Text style={s.meta}>{open ? "⌄" : "›"}</Text>
        <Text style={[s.meta, { fontFamily: fonts.uiMedium }]}>Graph context</Text>
        <Text numberOfLines={1} style={[s.meta, { flex: 1 }]}>
          {count(propositions.length, "proposition", "propositions")}{chains.length > 0 ? ` · ${count(chains.length, "chain", "chains")}` : ""}
        </Text>
      </Pressable>
      {open && (
        <View style={[dashed, { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs }]}>
          {propositions.map((item) => (
            <Text key={item.id} selectable style={[s.meta, { lineHeight: 18 }]}>
              <Text style={{ fontFamily: fonts.uiMedium, color: alpha(c.text, 0.8) }}>{item.name}</Text>: {item.statement}
            </Text>
          ))}
          {chains.map((chain, i) => <Text key={i} selectable style={s.meta}>{chain}</Text>)}
        </View>
      )}
    </View>
  );
}

// ─── Background helpers ─────────────────────────────────────────────────────

/** The running card's elapsed seconds. Only this label re-renders each
 * second, and it stops counting while the app is in the background. */
function Elapsed({ job }: { job: JobRecord }) {
  const { s } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | undefined;
    const start = () => { tick ??= setInterval(() => setNow(Date.now()), 1000); };
    if (AppState.currentState === "active") start();
    const subscription = AppState.addEventListener("change", (state) => {
      clearInterval(tick);
      tick = undefined;
      if (state === "active") { setNow(Date.now()); start(); }
    });
    return () => { clearInterval(tick); subscription.remove(); };
  }, []);
  const elapsed = elapsedSeconds(job, now);
  return elapsed === null ? null : <Text style={s.meta}>· {elapsed}s</Text>;
}

/** dispatch-card.tsx: a running helper is a live card; a settled one is one quiet line. */
export function DispatchCard({ kind, job }: { kind: JobKind; job?: JobRecord }) {
  const { c, s } = useTheme();
  const label = jobLabel(kind, job);
  if (!job || job.status === "running") {
    return (
      <View style={s.card}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ActivityIndicator size="small" color={c.muted} accessibilityLabel={`${label} running`} />
          <Text style={s.label}>{label}</Text>
          {job && <Elapsed job={job} />}
        </View>
        {!!job?.activity && <Text numberOfLines={1} style={s.muted}>{job.activity}</Text>}
        {!job && <Text style={s.muted}>Dispatched…</Text>}
      </View>
    );
  }
  const refusal = isModelsRefusal(job.error) ? "needs model setup" : isProviderKeyRefusal(job.error) ? "needs a provider key" : "";
  const failed = job.status === "error";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text style={[s.meta, failed && !refusal && { color: c.error }]}>{refusal ? "⚙" : failed ? "✗" : "✓"}</Text>
      <Text style={s.label}>{label}</Text>
      <Text style={s.meta}>{refusal ? `${refusal}. Set it up in the browser.` : failed ? "failed" : "finished"}</Text>
    </View>
  );
}

function ResearchBrief({ result }: { result?: ResearchResult }) {
  const { c, s } = useTheme();
  if (!result || typeof result.brief !== "string") return <View style={s.card}><Text style={s.muted}>Research completed, but the result could not be displayed.</Text></View>;
  const failed = result.brief.startsWith("Research failed");
  return (
    <View style={s.card}>
      <View style={{ flexDirection: "row", gap: space.sm }}><Label>Research brief</Label>{failed && <Text style={[s.label, { color: c.error }]}>failed</Text>}</View>
      <Markdown text={result.brief} />
      {result.sources.length > 0 && (
        <View style={[s.divider, { paddingTop: space.sm, gap: 2 }]}>
          <Label>Sources</Label>
          {result.sources.map((source) => isWebSourceUrl(source.url)
            ? <Text key={source.url} numberOfLines={1} accessibilityRole="link" onPress={() => confirmExternalLink(source.url)}
              style={[s.meta, { color: c.text, textDecorationLine: "underline" }]}>{source.title}</Text>
            : <Text key={source.url} numberOfLines={1} style={s.meta}>{source.title}</Text>)}
        </View>
      )}
    </View>
  );
}

function PdfBrief({ result }: { result?: PdfResult }) {
  const { c, s } = useTheme();
  if (!result || typeof result.brief !== "string") return <View style={s.card}><Text style={s.muted}>PDF reading completed, but the result could not be displayed.</Text></View>;
  const failed = result.brief.startsWith("PDF failed");
  const read = result.pagesRead ?? result.pagesConsulted ?? [];
  const consulted = result.pagesConsulted ?? [];
  return (
    <View style={s.card}>
      <View style={{ flexDirection: "row", gap: space.sm }}><Label>PDF brief</Label>{failed && <Text style={[s.label, { color: c.error }]}>failed</Text>}</View>
      <Markdown text={result.brief} />
      {!failed && read.length > 0 && <Text style={[s.meta, s.divider, { paddingTop: space.sm }]}>Pages read: {read.join(", ")}</Text>}
      {!failed && consulted.length > read.length && <Text style={[s.meta, s.divider, { paddingTop: space.sm }]}>Pages consulted: {consulted.join(", ")}</Text>}
    </View>
  );
}

/** worker-result-presentation.tsx: a ✓ line that opens the full result on demand. */
function ResultLine({ icon = "✓", label, detail, viewLabel = "view brief", hideLabel = "hide brief", children }: {
  icon?: string; label: string; detail?: string; viewLabel?: string; hideLabel?: string; children: ReactNode;
}) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.sm }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
        <Text style={[s.meta, icon === "✗" && { color: c.error }]}>{icon}</Text>
        <Text style={s.label}>{label}</Text>
        {!!detail && <Text style={s.meta}>{detail}</Text>}
        <Text style={[s.meta, { color: alpha(c.muted, 0.7) }]}>{open ? hideLabel : viewLabel}</Text>
      </Pressable>
      {open && children}
    </View>
  );
}

/** steer-card.tsx: a helper's delivered result, never shown as the learner's words.
 * Demos and figures wait for follow-up 5 and point at the browser. */
export function SteerCard({ message }: { message: LhViewMessage }) {
  const { s } = useTheme();
  const data = message.parts.find((part) => part.type === "data-subagent-artifact")?.data as SubagentArtifactData | undefined;
  if (!data) {
    const aborted = message.parts.find((part) => part.type === "data-subagent-aborted")?.data as { kind?: string; failure?: string } | undefined;
    if (typeof aborted?.failure === "string") return (
      <View accessibilityRole="alert" style={s.card}>
        <Text style={s.heading}>Background job recovery/delivery failed</Text>
        <Text selectable style={s.muted}>{aborted.failure}</Text>
      </View>
    );
    if (aborted) return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={s.meta}>⊗</Text><Text style={s.label}>{aborted.kind ?? "job"}</Text><Text style={s.meta}>aborted by the learner</Text>
      </View>
    );
    return <View style={s.card}><Text style={s.muted}>A sub-agent finished, but its result could not be displayed.</Text></View>;
  }
  switch (data.kind) {
    case "research": {
      const result = data.result as ResearchResult;
      if (isSubagentFailure("research", result)) return <ResearchBrief result={result} />;
      return <ResultLine label="Research" detail={`complete${result.sources.length > 0 ? ` · ${result.sources.length} sources` : ""}`}><ResearchBrief result={result} /></ResultLine>;
    }
    case "pdf": {
      const result = data.result as PdfResult;
      if (isSubagentFailure("pdf", result)) return <PdfBrief result={result} />;
      const pages = result.pagesRead ?? result.pagesConsulted;
      return <ResultLine label="PDF" detail={`reading complete${pages.length > 0 ? ` · read ${count(pages.length, "page", "pages")}` : ""}`}><PdfBrief result={result} /></ResultLine>;
    }
    case "plugin": {
      const result = data.result as PluginBackgroundResult;
      const status = result.outcome.status;
      return (
        <View style={{ gap: space.xs }}>
          {!!result.formatError && <Text accessibilityRole="alert" style={s.error}>Result formatting failed: {result.formatError}</Text>}
          <ResultLine icon={status === "succeeded" ? "✓" : status === "failed" ? "✗" : "⊗"} label={result.toolName} detail={status === "succeeded" ? undefined : status}
            viewLabel="show" hideLabel="hide">
            <Markdown text={result.text} />
          </ResultLine>
        </View>
      );
    }
    case "demo":
    case "visual":
      return (
        <View style={s.card}>
          <Label>{data.kind === "demo" ? "Demo" : "Figure"}</Label>
          <Text style={s.muted}>Open this session in the browser to see it. The … menu above opens it.</Text>
        </View>
      );
  }
}
