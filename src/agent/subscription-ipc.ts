import { webSubscriptionRequest, webSubscriptionsEnabled } from "./subscription-runtime.ts";

interface PendingCall {
	op: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Next dev also uses parent/child IPC. Require the desktop launch markers
 * set by Electron startServer before trusting IPC as the desktop transport. */
export function desktopIPCConnected(): boolean {
	return process.env.LH_DESKTOP_SERVER === "1"
		&& (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64
		&& typeof process.send === "function"
		&& process.connected === true;
}

export function subscriptionRuntimeConnected(): boolean {
	return desktopIPCConnected() || webSubscriptionsEnabled();
}

export interface DesktopIpcChannelOptions {
	channel: "lh:chatgpt" | "lh:subscriptions";
	unavailableError: string;
	timeoutError: string;
	closedError: string;
	failedError: string;
}

export class DesktopIpcChannel {
	private pending = new Map<string, PendingCall>();
	private counter = 0;

	constructor(private readonly options: DesktopIpcChannelOptions) {}

	request<T>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
		if (webSubscriptionsEnabled()) return webSubscriptionRequest<T>(this.options.channel, op, fields);
		if (!desktopIPCConnected()) return Promise.reject(new Error(this.options.unavailableError));
		return new Promise<T>((resolve, reject) => {
			const id = `${process.pid}:${++this.counter}`;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(this.options.timeoutError));
			}, 45000);
			this.pending.set(id, { op, resolve: (value) => resolve(value as T), reject, timer });
			process.send!({ ...fields, channel: this.options.channel, id, op }, (error) => {
				if (error) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(new Error(this.options.closedError));
				}
			});
		});
	}

	resolveReply(message: { id?: string; op?: string; ok?: boolean; value?: unknown; error?: string }): void {
		if (!message.id) return;
		const call = this.pending.get(message.id);
		if (!call || call.op !== message.op) return;
		clearTimeout(call.timer);
		this.pending.delete(message.id);
		if (message.ok === true) call.resolve(message.value);
		else call.reject(new Error(message.error ?? this.options.failedError));
	}

	rejectAll(errorMessage = "The desktop connection closed."): void {
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error(errorMessage));
		}
		this.pending.clear();
	}
}
