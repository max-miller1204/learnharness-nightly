export const MAX_INPUT: number;
export const MAX_OUTPUT: number;
export const TRUNCATED: string;
export const ENCRYPTED: string;
export const EMPTY: string;
export function extractDocumentText(bytes: Uint8Array, extension: string): Promise<string>;
