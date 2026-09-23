// Host-independent OpenRouter summary request; callers own configuration and storage.
export class SummaryError extends Error {
  constructor(code, message) { super(message); this.name = 'SummaryError'; this.code = code; }
}

// Preserve existing Markdown links and code while linking plain video timestamps.
export function linkTimestamps(markdown, videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return markdown;
  const stamp = String.raw`(?:\d+:[0-5]\d:[0-5]\d|\d+:[0-5]\d)`;
  const pattern = new RegExp(
    String.raw`(?<protected>\x60\x60\x60[^\n]*\n[\s\S]*?(?:\x60\x60\x60|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)|\x60+[^\x60\n]*\x60+|!?\[[^\]\n]*\]\([^\n]*?\)|\[[^\]\n]*\]\[[^\]\n]*\]|https?://[^\s<>]+)|(?<![\w:])(?<label>\[?(?<start>${stamp})(?:\s*[–—-]\s*${stamp})?\]?)(?![\w:])`, 'g');
  return markdown.replace(pattern, (match, ...args) => {
    const groups = args.at(-1);
    if (groups.protected !== undefined) return match;
    const seconds = groups.start.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    return `[${groups.label.replace(/^\[|\]$/g, '')}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}s)`;
  });
}

function timestamp(seconds) {
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  return total >= 3600 ? `${Math.floor(total / 3600)}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function summarySource(video) {
  const { metadata = {}, segments, selected_track: track } = video || {};
  if (!Array.isArray(segments) || !segments.length) {
    throw new SummaryError('EMPTY_TRANSCRIPT', 'A nonempty transcript is required.');
  }
  const lines = [
    `Title: ${metadata.title || 'Untitled video'}`,
    `Channel: ${metadata.channel_name || 'Unknown channel'}`,
    `Video URL: ${metadata.source_url || ''}`,
    `Published: ${metadata.published_date || 'unknown'}`,
    `Duration (seconds): ${metadata.duration_seconds || 'unknown'}`,
    `Captions: ${track?.language || 'unknown'}; ${track?.is_generated === true ? 'auto-generated' : track?.is_generated === false ? 'human-created' : 'unknown origin'}`,
    '', 'Description (may contain creator chapters):', metadata.description || '(none)',
    '', 'Timestamped transcript:',
  ];
  for (const segment of segments) {
    if (!Number.isFinite(segment?.start) || segment.start < 0 || typeof segment.text !== 'string' || !segment.text.trim()) {
      throw new SummaryError('INVALID_TRANSCRIPT', 'Transcript segments require nonnegative start seconds and text.');
    }
    lines.push(`[${timestamp(segment.start)}] ${segment.text.trim()}`);
  }
  return lines.join('\n');
}

export async function summarizeVideo(video, { apiKey, model, prompt, fetch: fetchImpl = globalThis.fetch,
  signal, timeoutMs = 300000, maxTokens = 16384, temperature = 0.2,
  webSearch = false, searchResults = 3 } = {}) {
  for (const [name, value] of [['OPENROUTER_API_KEY', apiKey], ['MODEL', model], ['summary prompt', prompt]]) {
    if (typeof value !== 'string' || !value.trim()) throw new SummaryError('CONFIGURATION', `${name} is missing or empty.`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new SummaryError('CONFIGURATION', 'timeoutMs must be between 1 and 600000.');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 65536) {
    throw new SummaryError('CONFIGURATION', 'maxTokens must be an integer between 128 and 65536.');
  }
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new SummaryError('CONFIGURATION', 'temperature must be between 0 and 2, or omitted with null.');
  }
  if (typeof webSearch !== 'boolean' || !Number.isInteger(searchResults) || searchResults < 1 || searchResults > 5) {
    throw new SummaryError('CONFIGURATION', 'Web search requires a boolean and 1–5 results.');
  }
  const source = summarySource(video);
  if (source.length > 300000) throw new SummaryError('SOURCE_TOO_LARGE', 'The source exceeds 300,000 characters; it was not truncated or sent.');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    combined.throwIfAborted();
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'YouTube Transcript JavaScript' },
      body: JSON.stringify({ model: model.trim(), ...(temperature === null ? {} : { temperature }), max_tokens: maxTokens,
        ...(webSearch ? { plugins: [{ id: 'web', engine: 'exa', max_results: searchResults }] } : {}),
        messages: [{ role: 'system', content: prompt.trim() }, { role: 'user', content: source }] }),
    });
    if (!response.ok) {
      const reason = { 400: 'Check model parameters and context limits; try provider-default temperature.',
        401: 'Check the OpenRouter API key.', 402: 'OpenRouter credits are insufficient.',
        403: 'The key or provider is not authorized for this request.',
        404: 'The selected model or provider route is unavailable.',
        429: 'The provider rate limit was reached; retry later.' }[response.status] || 'The provider could not complete the request.';
      throw new SummaryError('PROVIDER_ERROR', `OpenRouter rejected the request (HTTP ${response.status}). ${reason}`);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new SummaryError('INVALID_RESPONSE', 'OpenRouter returned an unreadable response.'); }
    if (payload?.error) throw new SummaryError('PROVIDER_ERROR', 'OpenRouter reported a generation error.');
    const choice = payload?.choices?.[0];
    if (['length', 'content_filter'].includes(choice?.finish_reason)) {
      throw new SummaryError('INCOMPLETE_RESPONSE', 'OpenRouter returned an incomplete or filtered summary.');
    }
    const content = choice?.message?.content;
    const summary = (typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '').trim();
    if (!summary) throw new SummaryError('EMPTY_RESPONSE', 'OpenRouter did not return a text summary.');
    const usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
      if (Number.isFinite(payload.usage?.[key])) usage[key] = payload.usage[key];
    }
    if (Number.isFinite(payload.usage?.completion_tokens_details?.reasoning_tokens)) {
      usage.reasoning_tokens = payload.usage.completion_tokens_details.reasoning_tokens;
    }
    const citations = [];
    for (const entry of choice.message?.annotations || []) {
      const cite = entry?.type === 'url_citation' && entry.url_citation;
      try {
        const url = new URL(cite.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        if (!citations.some(c => c.url === url.href)) citations.push({ url: url.href,
          title: String(cite.title || url.hostname).replace(/[\[\]\\\r\n]/g, ' ') });
      } catch { /* Ignore malformed or non-web citations. */ }
    }
    const sourceList = webSearch && citations.length ? '\n\n## Sources returned for verification\n\n' +
      citations.map(c => `- [${c.title}](<${c.url.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`).join('\n') : '';
    return { summary: linkTimestamps(summary, video.metadata?.video_id) + sourceList, raw_summary: summary, citations,
      requested_model: model.trim(), model: typeof payload.model === 'string' ? payload.model : model.trim(),
      finish_reason: choice.finish_reason || null, usage };
  } catch (error) {
    if (signal?.aborted) throw new SummaryError('CANCELLED', 'Summary generation was cancelled.');
    if (deadline.aborted) throw new SummaryError('TIMEOUT', 'Summary generation exceeded its deadline.');
    if (error instanceof SummaryError) throw error;
    throw new SummaryError('NETWORK_ERROR', 'Could not reach OpenRouter. Check the connection and try again.');
  }
}
