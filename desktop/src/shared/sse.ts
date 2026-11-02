/**
 * A small parser for server-sent events (text/event-stream), written here rather than taken from a
 * library so every line can be explained.
 *
 * The format: events are separated by a blank line; each line is `field:value`. SMOI's backend
 * sends `event:<name>` and one `data:<json>` line per event. Multiple `data:` lines are joined
 * with newlines, and lines starting with `:` are comments. Text arrives in arbitrary pieces, so
 * the parser keeps whatever comes after the last complete event until the next piece.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';

  /** Feeds the next piece of text; returns the events it completed. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const out: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const message = parseBlock(block);
      if (message) out.push(message);
    }
    return out;
  }
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
