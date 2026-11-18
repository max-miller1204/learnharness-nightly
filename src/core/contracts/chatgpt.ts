/** Client-safe status only. Credentials and OAuth transaction data never enter this contract. */
export interface ChatGPTStatus {
	available: boolean;
	pending: boolean;
	/** App-wide ChatGPT background permission, independent of account selection. */
	allowBackgroundUse: boolean;
	activeId: string | null;
	/** Non-secret ID of the current account selection, stable across restarts. */
	accountSelection?: string;
	accounts: {
		id: string; email: string; registration: string; connected: boolean; planEnabled?: boolean;
		/** Main-owned authorization recovery eligibility. Missing means unknown, not eligible.
		 * False for storage failures, paused/closed connections, and healthy authorization. */
		canSignInAgain?: boolean;
	}[];
	error: string | null;
	catalogError?: string | null;
}
export interface ChatGPTControlBridge {
	status(): Promise<ChatGPTStatus>;
	login(id?: string): Promise<ChatGPTStatus>;
	cancel(): Promise<ChatGPTStatus>;
	/** Paste-back: the sign-in tab's final 127.0.0.1 address, for a browser on another device. */
	complete(callbackUrl: string): Promise<ChatGPTStatus>;
	select(id: string): Promise<ChatGPTStatus>;
	/** Explicitly forget every local registration/credential for this verified identity. */
	disconnect(id: string): Promise<ChatGPTStatus>;
	logout(id: string): Promise<ChatGPTStatus>;
	consent(enabled: boolean): Promise<ChatGPTStatus>;
	onChange(callback: () => void): () => void;
}
