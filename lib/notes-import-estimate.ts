/**
 * The folder-pick cost estimate (docs/specs/extract-more-types.md, "Estimate endpoint"). Pure: the route
 * supplies the current models and the pricer. The constants were measured on real Extract files runs
 * (see the spec's measurement table) and are deliberately rough.
 */

export interface ImportEstimateInput {
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
}
type Call = { inputTokens: number; outputTokens: number };
export type ImportPricer = (call: Call, modelId: string) => number | null;

/** Text characters per file byte, measured on the PR's sample files. */
export const PDF_CHARS_PER_BYTE = 0.05;
export const DOCUMENT_CHARS_PER_BYTE = 0.5;
/** Per source token: extractor and auditor tokens billed (prompt, digest and replies included). */
export const EXTRACTOR_INPUT_PER_TOKEN = 2.5;
export const EXTRACTOR_OUTPUT_PER_TOKEN = 0.4;
export const AUDITOR_INPUT_PER_TOKEN = 2;
export const AUDITOR_OUTPUT_PER_TOKEN = 0.15;
/** Per chunk: the fixed system prompt and tool declarations, billed to each stage. */
export const EXTRACTOR_INPUT_PER_CHUNK = 1_500;
export const AUDITOR_INPUT_PER_CHUNK = 1_500;
/** Per image: the Vision call, and the description's size as source text. */
export const IMAGE_INPUT_TOKENS = 1_600;
export const IMAGE_OUTPUT_TOKENS = 600;
export const IMAGE_DESCRIPTION_TOKENS = 600;

const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function validEstimateInput(body: unknown): body is ImportEstimateInput {
	if (!body || typeof body !== "object") return false;
	const record = body as Record<string, unknown>;
	return (["notesChars", "codeChars", "images", "pdfBytes", "documentBytes"] as const).every((key) => nonNegative(record[key]));
}

export function estimateImport(
	input: ImportEstimateInput,
	models: { extractor?: string; auditor?: string; imageReader?: string },
	price: ImportPricer,
	chunkTokens: number,
): ImportEstimate {
	const rough = input.pdfBytes > 0 || input.documentBytes > 0;
	const sourceTokens = Math.ceil((input.notesChars + input.codeChars + input.pdfBytes * PDF_CHARS_PER_BYTE + input.documentBytes * DOCUMENT_CHARS_PER_BYTE) / 4)
		+ input.images * IMAGE_DESCRIPTION_TOKENS;
	const chunks = sourceTokens === 0 ? 0 : Math.ceil(sourceTokens / chunkTokens) + input.images;
	const calls: Array<[string | undefined, Call]> = [];
	if (sourceTokens > 0) {
		calls.push([models.extractor, { inputTokens: Math.round(sourceTokens * EXTRACTOR_INPUT_PER_TOKEN + chunks * EXTRACTOR_INPUT_PER_CHUNK), outputTokens: Math.round(sourceTokens * EXTRACTOR_OUTPUT_PER_TOKEN) }]);
		calls.push([models.auditor, { inputTokens: Math.round(sourceTokens * AUDITOR_INPUT_PER_TOKEN + chunks * AUDITOR_INPUT_PER_CHUNK), outputTokens: Math.round(sourceTokens * AUDITOR_OUTPUT_PER_TOKEN) }]);
	}
	if (input.images > 0) calls.push([models.imageReader, { inputTokens: input.images * IMAGE_INPUT_TOKENS, outputTokens: input.images * IMAGE_OUTPUT_TOKENS }]);
	const tokens = calls.reduce((sum, [, call]) => sum + call.inputTokens + call.outputTokens, 0);
	let usd: number | null = 0;
	let unpriced: string | undefined;
	for (const [model, call] of calls) {
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
