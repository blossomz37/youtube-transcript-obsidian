// Unofficial InnerTube Android player + JSON3 captions. No cookies or API keys.
// Protocol reference: youtube-transcript 1.3.1 (MIT), https://github.com/Kakulukian/youtube-transcript
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const CLIENT_VERSION = '20.10.38';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class RetrievalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RetrievalError';
    this.code = code;
  }
}

export function extractVideoId(source) {
  const value = typeof source === 'string' ? source.trim() : '';
  if (VIDEO_ID.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v')
        : /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
    if (VIDEO_ID.test(id || '')) return id;
  } catch { /* Report only the input contract, never an arbitrary URL. */ }
  throw new RetrievalError('INVALID_INPUT', 'Enter a supported YouTube URL or 11-character video ID.');
}

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.simpleText === 'string') return value.simpleText;
  return value?.runs?.map(run => run.text || '').join('') || '';
}

function trackDescriptor(track) {
  return {
    language: text(track.name),
    language_code: track.languageCode,
    is_generated: track.kind === 'asr',
    is_translatable: track.isTranslatable === true,
  };
}

export function selectTrack(tracks, language) {
  if (!tracks.length) return null;
  if (tracks.some(track => typeof track?.languageCode !== 'string' || typeof track?.baseUrl !== 'string')) {
    throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an invalid caption track.');
  }
  let candidates = language ? tracks.filter(track => track.languageCode === language)
    : tracks.filter(track => /^en(?:-|$)/i.test(track.languageCode));
  if (language && !candidates.length) {
    throw new RetrievalError('LANGUAGE_UNAVAILABLE', 'The requested caption language is unavailable.');
  }
  if (!candidates.length) candidates = tracks;
  return candidates.find(track => track.kind !== 'asr') || candidates[0];
}

export function parseJson3(payload) {
  if (!Array.isArray(payload?.events)) {
    throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an unexpected caption format.');
  }
  const segments = [];
  for (const event of payload.events) {
    if (!event || typeof event !== 'object') {
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an invalid caption event.');
    }
    // JSON3 also contains window/style events without caption text.
    if (event.segs === undefined) continue;
    if (!Array.isArray(event.segs) || event.segs.some(segment => typeof segment?.utf8 !== 'string')) {
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned invalid caption text.');
    }
    const caption = event.segs.map(segment => segment.utf8).join('')
      .replace(/\s+/gu, ' ').trim().replace(/^(?:>>\s*)+/, '').trim();
    if (!caption) continue;
    const start = event.tStartMs;
    const duration = event.dDurationMs;
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration < 0) {
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned invalid caption timing.');
    }
    segments.push({ start: start / 1000, duration: duration / 1000, text: caption });
  }
  if (!segments.length) {
    throw new RetrievalError('EMPTY_CAPTIONS', 'A caption track exists, but YouTube returned no caption text.');
  }
  return segments;
}

function captionUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { /* Validated below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
      || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
      || url.pathname !== '/api/timedtext') {
    throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an unsupported caption URL.');
  }
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

async function requestJson(fetchImpl, url, options, signal) {
  const response = await fetchImpl(url, { ...options, signal, redirect: 'error', credentials: 'omit' });
  if (!response.ok) {
    const code = [403, 429].includes(response.status) ? 'BLOCKED' : 'HTTP_ERROR';
    throw new RetrievalError(code, `YouTube request failed (HTTP ${response.status}).`);
  }
  try { return await response.json(); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an empty or non-JSON response.');
  }
}

/** Core uses only web APIs. Host adapters must implement fetch and honor AbortSignal.
 * Timings are seconds, matching app/youtube_service.py. No filesystem or subprocesses.
 */
export async function loadVideo(source, { language, fetch: fetchImpl = globalThis.fetch,
  signal, timeoutMs = 30000 } = {}) {
  const videoId = extractVideoId(source);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) {
    throw new RetrievalError('INVALID_INPUT', 'timeoutMs must be an integer from 1 to 180000.');
  }
  if (language !== undefined && (typeof language !== 'string' || !language.trim())) {
    throw new RetrievalError('INVALID_INPUT', 'language must be a nonempty caption language code.');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    combined.throwIfAborted();
    const player = await requestJson(fetchImpl, PLAYER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'User-Agent': `com.google.android.youtube/${CLIENT_VERSION} (Linux; U; Android 14)` },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: CLIENT_VERSION } }, videoId }),
    }, combined);
    const playability = player?.playabilityStatus;
    if (playability?.status !== 'OK') {
      const reason = String(playability?.reason || '');
      if (/bot|unusual traffic|too many requests/i.test(reason)) {
        throw new RetrievalError('BLOCKED', 'YouTube blocked this unauthenticated request. Try again later.');
      }
      if (['ERROR', 'UNPLAYABLE', 'LOGIN_REQUIRED', 'LIVE_STREAM_OFFLINE'].includes(playability?.status)) {
        throw new RetrievalError('VIDEO_UNAVAILABLE', 'This video is unavailable to this unauthenticated client.');
      }
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an unexpected player response.');
    }
    const details = player.videoDetails;
    if (!details || details.videoId !== videoId || typeof details.title !== 'string') {
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned missing or mismatched video metadata.');
    }
    const microformat = player.microformat?.playerMicroformatRenderer || {};
    const metadata = {
      video_id: videoId,
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      title: details.title,
      channel_name: details.author || '',
      channel_id: details.channelId || '',
      channel_url: details.channelId ? `https://www.youtube.com/channel/${details.channelId}` : '',
      description: details.shortDescription || '',
      duration_seconds: Number(details.lengthSeconds) || 0,
      published_date: microformat.publishDate || '',
      thumbnail_url: details.thumbnail?.thumbnails?.at(-1)?.url || '',
      is_live: details.isLive === true,
    };
    const captionRenderer = player.captions?.playerCaptionsTracklistRenderer;
    const tracks = captionRenderer?.captionTracks ?? [];
    if (!Array.isArray(tracks) || (player.captions && !Array.isArray(captionRenderer?.captionTracks))) {
      throw new RetrievalError('UPSTREAM_CHANGED', 'YouTube returned an unexpected caption listing.');
    }
    const selected = selectTrack(tracks, language);
    if (!selected) return { status: 'no_captions', metadata, segments: [], selected_track: null,
      available_tracks: [], warnings: ['YouTube exposed no caption tracks to this client.'] };
    const payload = await requestJson(fetchImpl, captionUrl(selected.baseUrl), {}, combined);
    return { status: 'ok', metadata, segments: parseJson3(payload),
      selected_track: trackDescriptor(selected), available_tracks: tracks.map(trackDescriptor), warnings: [] };
  } catch (error) {
    if (signal?.aborted) throw new RetrievalError('CANCELLED', 'Video retrieval was cancelled.');
    if (deadline.aborted) throw new RetrievalError('TIMEOUT', 'Video retrieval exceeded its deadline.');
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError('NETWORK_ERROR', 'Could not reach YouTube. Check the connection and try again.');
  }
}
