import type { ChatInput, LhMessage, TurnStreamEvent } from "../../../src/client-protocol/index.ts";

type DismissProblem = { type: "dismiss-problem"; problemCallId: string };
export type SessionInput = ChatInput | DismissProblem;

/** The turn stream replays full partial snapshots. Use their message slot,
 * and rebuild the entire transient tail when attaching again. */
export function turnReplay() {
  let messages: LhMessage[] = [];
  let slot: number | undefined;
  return (event: TurnStreamEvent): LhMessage[] | undefined => {
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (event.type === "message_start" || slot === undefined) slot = messages.length;
    const snapshot = { ...message, id: `mobile-live-${slot}` };
    messages = [...messages.slice(0, slot), snapshot];
    if (event.type === "message_end") slot = undefined;
    return messages;
  };
}

/** A failed HTTP response can arrive after a write committed. Look for the
 * corresponding new input in the authoritative record before offering retry. */
export function inputWasSaved(messages: readonly LhMessage[], priorIds: ReadonlySet<string>, input: SessionInput): boolean {
  return messages.some((message) => {
    if (priorIds.has(message.id)) return false;
    switch (input.type) {
      case "text": {
        if (message.role !== "user") return false;
        const text = typeof message.content === "string" ? message.content
          : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        return text === input.text;
      }
      case "answer":
        return message.role === "toolResult" && message.toolCallId === input.toolCallId && !message.isError;
      case "retry":
      case "continue":
      case "retry-question":
        return message.role === "assistant";
      case "next":
        return message.role === "custom" && message.customType === "practice-next";
      case "thinking":
      case "dismiss-problem": {
        if (message.role !== "custom") return false;
        const details = message.details as { problemCallId?: string; text?: string } | undefined;
        return details?.problemCallId === input.problemCallId &&
          (input.type === "thinking"
            ? message.customType === "practice-thinking" && details.text === input.text
            : message.customType === "problem-dismissed");
      }
      default:
        return false;
    }
  });
}
