/** Parse SSE across arbitrary transport chunks. Frames only dispatch on a
 * blank line. Comments and field types unused by protocol 1 are ignored. */
export async function consumeSse(
  body: ReadableStream<Uint8Array> | null,
  onFrame: (event: string, data: string) => boolean | void,
  onChunk?: () => void,
): Promise<void> {
  if (!body) throw new Error("The server returned an empty stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let afterCr = false;
  let event = "message";
  let data: string[] = [];

  function finishLine() {
    if (line === "") {
      const keepGoing = data.length ? onFrame(event, data.join("\n")) : undefined;
      event = "message";
      data = [];
      return keepGoing;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + (line[separator + 1] === " " ? 2 : 1));
    if (field === "event") event = value || "message";
    if (field === "data") data.push(value);
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      onChunk?.();
      for (const char of decoder.decode(chunk.value, { stream: true })) {
        if (char === "\n" && afterCr) {
          afterCr = false;
          continue;
        }
        afterCr = char === "\r";
        if (char === "\n" || afterCr) {
          if (finishLine() === false) return;
          line = "";
        } else {
          line += char;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
