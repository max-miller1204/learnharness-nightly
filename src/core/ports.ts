/**
 * Storage ports implemented by adapters in `src/store/` and wired in `src/server/stores.ts`.
 */

import type { LhMessage } from "./native-messages.ts";
import type { PluginAgentRecord } from "./plugin-agents.ts";
import type { PluginTaskRecord } from "./plugin-workers.ts";
import type {
	ChatRecord,
	ImageSnapshot,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	PluginJobMetadata,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	SideChatThread,
	TurnUsage,
	NotesSource,
} from "./contracts.ts";
import type { UserSettings } from "./settings.ts";
import type { Theme, ThemeFile } from "./themes.ts";

/** One writer per plugin directory. Failed atomic replacements must throw. */
export interface PluginAgentRecordStore {
	list(): PluginAgentRecord[];
	get(id: string): PluginAgentRecord | null;
	save(record: PluginAgentRecord): void;
}

/** One writer per plugin task directory; accepted results require an atomic save. */
export interface PluginTaskRecordStore {
	list(): PluginTaskRecord[];
	get(id: string): PluginTaskRecord | null;
	save(record: PluginTaskRecord): void;
}

export interface ChatStore {
	createChat(title: string, kind?: "practice"): ChatRecord;
	getChat(id: string): ChatRecord | null;
	listChats(): ChatSummary[];
	saveMessages(id: string, messages: LhMessage[], options?: { atomic: boolean }): void;
	/** Save a processed image once without advancing `updatedAt`. */
	saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): void;
	saveTree(id: string, tree: PlanTree): void;
	/** Idempotent per turn id. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Idempotent per `startedAt`. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	saveSettings(id: string, settings: ChatSettings): void;
	/** Rename without advancing `updatedAt`. */
	renameChat(id: string, title: string): ChatRecord;
	deleteChat(id: string): boolean;
	/** Synchronous per-field read-modify-write so concurrent turns are not clobbered; does not advance `updatedAt`. */
	updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): SideChatThread[] | null;
}

export interface GraphStore {
	appendNode(node: GraphNode): void;
	readNodes(): GraphNode[];
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];
	/** Upsert preserves any existing usage log on the record. */
	upsertSource(source: NotesSource): void;
	readSources(): NotesSource[];
	deleteSources(ids: ReadonlySet<string>): number;
	/** Idempotent per `startedAt`. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;
	readPositions(): Record<string, Position>;
	writePositions(positions: Record<string, Position>): void;
	/** Atomically replace each provided ledger file; omitted keys stay untouched. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void;
}

export interface SourceOrganizationStore {
	read(): import("./source-organization.ts").SourceOrganization;
	write(state: import("./source-organization.ts").SourceOrganization): void;
}

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	activity?: string;
	plugin?: PluginJobMetadata;
	input?: unknown;
}

export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	listJobs(chatId: string): JobRecord[];
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
	deleteJobsForChat(chatId: string): number;
}

export interface SettingsStore {
	readSettings(): UserSettings | null;
	writeSettings(settings: UserSettings): void;
}

export interface ThemeStore {
	listThemes(): Theme[];
	readTheme(id: string): Theme | null;
	writeTheme(id: string, theme: ThemeFile): void;
	deleteTheme(id: string): void;
}

export interface PromptOverrideStore {
	listOverrides(): string[];
	readOverride(segmentPath: string): string | null;
	writeOverride(segmentPath: string, text: string): void;
	deleteOverride(segmentPath: string): void;
}

export interface AuthStore {
	authVars(): Record<string, string>;
	/** Atomic write with mode 0600, preserving other vars. */
	setAuthVar(name: string, value: string): void;
	deleteAuthVar(name: string): void;
}

