import type { ChatInput, LhMessage, QuestionDismissRequest, TurnStreamEvent } from "../../../src/client-protocol/index.ts";

type DismissProblem = { type: "dismiss-problem"; problemCallId: string };
export type SessionInput = ChatInput | DismissProblem | QuestionDismissRequest["input"];

/** The turn stream replays full partial snapshots. Use their message slot,
 * and rebuild the entire transient tail when attaching again. A tool's result
 * joins the tail as soon as the tool finishes (tool_execution_end, in completion
 * order), as the web's live view settles a call, and the result message that
 * follows later replaces it. */
export function turnReplay() {
  let messages: LhMessage[] = [];
  let slot: number | undefined;
  const settle = (result: LhMessage & { role: "toolResult" }) => {
    const at = messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === result.toolCallId);
    messages = at === -1 ? [...messages, result] : messages.map((message, index) => index === at ? result : message);
    return messages;
  };
  return (event: TurnStreamEvent): LhMessage[] | undefined => {
    if (event.type === "tool_execution_end") {
      const result = (event.result ?? {}) as { content?: unknown; details?: unknown };
      return settle({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
        content: Array.isArray(result.content) ? result.content : [], details: result.details, isError: event.isError,
        id: `mobile-live-result-${event.toolCallId}`, timestamp: Date.now() } as LhMessage & { role: "toolResult" });
    }
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
    const message = event.message;
    if (message.role === "toolResult") return event.type === "message_end" ? settle(message as LhMessage & { role: "toolResult" }) : undefined;
    if (message.role !== "assistant") return;
    if (event.type === "message_start" || slot === undefined) slot = messages.length;
    const snapshot = { ...message, id: `mobile-live-${slot}` };
    // Replace this message's slot; results that arrived after it stay.
    messages = slot === messages.length ? [...messages, snapshot] : messages.map((each, index) => index === slot ? snapshot : each);
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
      case "dismiss":
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
