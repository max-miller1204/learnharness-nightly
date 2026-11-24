import { Format } from "typebox/format";
import { Settings } from "typebox/system";
import type { JsonValue } from "./plugin-questions.ts";

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Copy only finite JSON, without invoking getters, toJSON, or coercion. */
export function clonePluginQuestionJson(value: unknown): JsonValue {
	return cloneJson(value);
}

export function cloneJson(value: unknown, schemaNodes?: Set<object>): JsonValue {
	const active = new Set<object>();
	function copy(item: unknown): JsonValue {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || item === null || (!Array.isArray(item) && !plainObject(item)) || active.has(item)) throw new Error("Plugin question data must be finite JSON");
		active.add(item);
		try {
			const descriptors = Object.getOwnPropertyDescriptors(item);
			if (Array.isArray(item)) {
				const keys = Reflect.ownKeys(descriptors);
				if (keys.length !== item.length + 1) throw new Error("Plugin question arrays must be dense JSON arrays");
				const result: JsonValue[] = [];
				for (let i = 0; i < item.length; i++) {
					const descriptor = descriptors[String(i)];
					if (!descriptor || !own(descriptor, "value") || !descriptor.enumerable) throw new Error("Plugin question arrays must contain JSON values");
					result.push(copy(descriptor.value));
				}
				return result;
			}
			const result: Record<string, JsonValue> = {};
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key as string]!;
				// Installed TypeBox branding is descriptive, non-enumerable metadata,
				// never a persisted validation rule. Only strip it at schema positions.
				if (schemaNodes?.has(item) && own(descriptor, "value") && !descriptor.enumerable &&
					((key === "~kind" && typeof descriptor.value === "string") ||
					((key === "~optional" || key === "~readonly") && typeof descriptor.value === "boolean") ||
					(key === "~unsafe" && descriptor.value === null))) continue;
				if (typeof key !== "string" || !own(descriptor, "value") || !descriptor.enumerable) throw new Error("Plugin question objects must have ordinary JSON properties");
				Object.defineProperty(result, key, { value: copy(descriptor.value), enumerable: true, configurable: true, writable: true });
			}
			return result;
		} finally { active.delete(item); }
	}
	return copy(value);
}

export function isPluginQuestionJson(value: unknown): value is JsonValue {
	try { clonePluginQuestionJson(value); return true; } catch { return false; }
}

/** Freeze owned copies, never plugin-owned input objects. */
export function freezePluginQuestionValue<T>(value: T): T {
	// Contexts can contain runtime capabilities such as AbortSignal. Freeze only
	// owned JSON containers and the plain context itself, never those capabilities.
	if ((Array.isArray(value) || plainObject(value)) && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezePluginQuestionValue(child);
		Object.freeze(value);
	}
	return value;
}

// Only copies created here carry this proof. An arbitrary plugin object, even
// a frozen one, is not evidence of ownership or stable reads (e.g. proxies).
const immutable = new WeakSet<object>();
const container = (value: object) => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
const immutableValue = (value: unknown): boolean => value === null || (typeof value === "object" ? immutable.has(value) : typeof value !== "function");

/** Detach host history at ingress, preserving undefined, sparse/malformed data
 * and TypeBox metadata for the existing parsers to judge. Never invoke getters
 * or freeze a caller's objects. Already owned subtrees retain their identity. */
export function copyImmutableData<T>(value: T): T {
	const copies = new WeakMap<object, object>();
	function copy(item: unknown): unknown {
		if (item === null || typeof item !== "object" || immutable.has(item) || !container(item)) return item;
		const previous = copies.get(item);
		if (previous) return previous;
		const result = Array.isArray(item) ? [] : Object.create(Object.getPrototypeOf(item));
		copies.set(item, result);
		let eligible = true;
		const descriptors = Object.getOwnPropertyDescriptors(item);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if ("value" in descriptor) {
				const child = copy(descriptor.value);
				if (!immutableValue(child)) eligible = false;
				Object.defineProperty(result, key, { ...descriptor, value: child });
			} else {
				eligible = false;
				Object.defineProperty(result, key, descriptor);
			}
		}
		Object.freeze(result);
		if (eligible) immutable.add(result);
		return result;
	}
	try { return copy(value) as T; }
	catch { return value; } // Unsupported runtime data must still reach the fail-closed readers.
}

// A compiled/parsed result must not outlive a change to TypeBox's validation
// policy or format functions. Keep one current environment, not a registry of
// epochs. Reading entries also notices changes made outside the host's API.
let formats = Format.Entries();
let settings = Object.entries(Settings.Get());
let epoch = {};
function validationEpoch(): object {
	const nextFormats = Format.Entries(), nextSettings = Object.entries(Settings.Get());
	if (formats.length !== nextFormats.length || formats.some(([key, value], i) => key !== nextFormats[i]![0] || value !== nextFormats[i]![1]) ||
		settings.length !== nextSettings.length || settings.some(([key, value], i) => key !== nextSettings[i]![0] || value !== nextSettings[i]![1])) {
		formats = nextFormats; settings = nextSettings; epoch = {};
	}
	return epoch;
}

/** Internal identity cache for reads of host-owned immutable data. One context
 * per weak key, with no strong history retention, global content keys or capacity
 * policy. Unowned inputs/contexts always take the original validation path. */
export class ImmutableReadCache<T> {
	private entries = new WeakMap<object, { context: unknown; epoch: object; value: T }>();
	read(input: unknown, context: unknown, compute: () => T): T {
		if (input === null || typeof input !== "object" || !immutable.has(input) || !immutableValue(context)) return compute();
		const currentEpoch = validationEpoch(), previous = this.entries.get(input);
		if (previous && previous.context === context && previous.epoch === currentEpoch) return previous.value;
		const value = copyImmutableData(compute());
		this.entries.set(input, { context, epoch: currentEpoch, value });
		return value;
	}
	seed(input: object, context: unknown, value: T): void {
		if (immutable.has(input) && immutableValue(context)) this.entries.set(input, { context, epoch: validationEpoch(), value: copyImmutableData(value) });
	}
}
