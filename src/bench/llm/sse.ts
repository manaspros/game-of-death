/** The slice of a chat-completions response the clients read; streamed chunks are reassembled into this shape. */
export interface ChatCompletionLike {
  choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] }; finish_reason: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/**
 * Reassembles an OpenAI-style SSE chat-completions stream (stream_options.include_usage) into one non-stream-shaped response:
 * tool_calls deltas are stitched by index (name and argument fragments concatenated), finish_reason and usage are kept.
 * Reasoning deltas and everything else are ignored. `onChunk` fires per received network chunk (progress / idle tracking).
 */
export async function readChatCompletionStream(body: ReadableStream<Uint8Array>, onChunk?: () => void): Promise<ChatCompletionLike> {
  const calls = new Map<number, { name: string; arguments: string }>();
  let finishReason: string | null = null;
  let usage: ChatCompletionLike['usage'];
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json: { choices?: { delta?: { tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: ChatCompletionLike['usage']; error?: { message?: string } };
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) throw new Error(`stream error: ${json.error.message ?? JSON.stringify(json.error).slice(0, 200)}`);
    const choice = json.choices?.[0];
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index ?? 0) ?? { name: '', arguments: '' };
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index ?? 0, cur);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) usage = json.usage;
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  }
  handle(buf.trim());
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ function: { name: c.name, arguments: c.arguments } }));
  return { choices: [{ message: tool_calls.length ? { tool_calls } : {}, finish_reason: finishReason }], usage };
}
