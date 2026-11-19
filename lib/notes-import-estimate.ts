/**
 * The folder-pick cost estimate (docs/specs/extract-more-types.md, "Estimate endpoint"). Pure: the route
 * supplies the current models and the pricer. The constants were fitted to real Extract files runs
 * (docs/specs/extract-more-types.md, "Estimate calibration") and are deliberately rough.
 */

export interface ImportEstimateInput {
	/** Sources the pick becomes (one per file, plus one for grouped code): each is at least one chunk. */
	sources: number;
	notesChars: number;
	codeChars: number;
	images: number;
	pdfBytes: number;
	documentBytes: number;
}
export interface ImportEstimate {
	/** Billed tokens, all calls, input plus output. */
	tokens: number;
	/** null when a model that would run has no price (subscription, custom, unknown). */
	usd: number | null;
	/** PDFs or documents were guessed from their file size. */
	rough: boolean;
	/** The first model without a price, when usd is null. */
	unpriced?: string;
	/** The first model that would run but the catalog no longer has, when usd is null. */
	unavailable?: string;
}
type Call = { inputTokens: number; outputTokens: number };
export type ImportPricer = (call: Call, modelId: string) => number | null;

/** Text characters per file byte: real PDFs measured 0.13 to 0.66 (median 0.26); text-heavy Office and
 * EPUB files 0.8 to 1.7, one with pictures 0.09. */
export const PDF_CHARS_PER_BYTE = 0.25;
export const DOCUMENT_CHARS_PER_BYTE = 0.5;
/** Per source token: extractor and auditor tokens billed (text, digest, schema retries and replies). */
export const EXTRACTOR_INPUT_PER_TOKEN = 3.5;
export const EXTRACTOR_OUTPUT_PER_TOKEN = 2;
export const AUDITOR_INPUT_PER_TOKEN = 1.5;
export const AUDITOR_OUTPUT_PER_TOKEN = 0.2;
/** Per chunk: the fixed system prompt, tool declarations and graph candidates. */
export const EXTRACTOR_INPUT_PER_CHUNK = 4_000;
export const EXTRACTOR_OUTPUT_PER_CHUNK = 500;
export const AUDITOR_INPUT_PER_CHUNK = 4_000;
export const AUDITOR_OUTPUT_PER_CHUNK = 250;
/** Per image: the Vision call, and the description's size as source text. */
export const IMAGE_INPUT_TOKENS = 1_400;
export const IMAGE_OUTPUT_TOKENS = 250;
export const IMAGE_DESCRIPTION_TOKENS = 250;

const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function validEstimateInput(body: unknown): body is ImportEstimateInput {
	if (!body || typeof body !== "object") return false;
	const record = body as Record<string, unknown>;
	return (["sources", "notesChars", "codeChars", "images", "pdfBytes", "documentBytes"] as const).every((key) => nonNegative(record[key]));
}

export function estimateImport(
	input: ImportEstimateInput,
	models: { extractor?: string; auditor?: string; imageReader?: string },
	price: ImportPricer,
	chunkTokens: number,
	available: (modelId: string) => boolean = () => true,
): ImportEstimate {
	const rough = input.pdfBytes > 0 || input.documentBytes > 0;
	const sourceTokens = Math.ceil((input.notesChars + input.codeChars + input.pdfBytes * PDF_CHARS_PER_BYTE + input.documentBytes * DOCUMENT_CHARS_PER_BYTE) / 4)
		+ input.images * IMAGE_DESCRIPTION_TOKENS;
	// Every source is at least one chunk; size adds the rest.
	const chunks = sourceTokens === 0 ? 0 : Math.max(1, input.sources) + Math.floor(sourceTokens / chunkTokens);
	const calls: Array<[string | undefined, Call]> = [];
	if (sourceTokens > 0) {
		calls.push([models.extractor, { inputTokens: Math.round(sourceTokens * EXTRACTOR_INPUT_PER_TOKEN + chunks * EXTRACTOR_INPUT_PER_CHUNK), outputTokens: Math.round(sourceTokens * EXTRACTOR_OUTPUT_PER_TOKEN + chunks * EXTRACTOR_OUTPUT_PER_CHUNK) }]);
		calls.push([models.auditor, { inputTokens: Math.round(sourceTokens * AUDITOR_INPUT_PER_TOKEN + chunks * AUDITOR_INPUT_PER_CHUNK), outputTokens: Math.round(sourceTokens * AUDITOR_OUTPUT_PER_TOKEN + chunks * AUDITOR_OUTPUT_PER_CHUNK) }]);
	}
	if (input.images > 0) calls.push([models.imageReader, { inputTokens: input.images * IMAGE_INPUT_TOKENS, outputTokens: input.images * IMAGE_OUTPUT_TOKENS }]);
	const tokens = calls.reduce((sum, [, call]) => sum + call.inputTokens + call.outputTokens, 0);
	let usd: number | null = 0;
	let unpriced: string | undefined;
	for (const [model, call] of calls) {
		if (model && !available(model)) return { tokens, usd: null, rough, unavailable: model };
		const cost = model ? price(call, model) : null;
		if (cost === null) {
			usd = null;
			unpriced = model ?? "an unconfigured model";
			break;
		}
		usd += cost;
	}
	return { tokens, usd, rough, ...(unpriced ? { unpriced } : {}) };
}
