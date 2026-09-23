import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, loadVideo, parseJson3, selectTrack } from '../src/retrieval.mjs';

const id = 'abcdefghijk';
const track = (languageCode = 'en', kind) => ({ languageCode, kind,
  baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&sig=synthetic',
  name: { simpleText: languageCode }, isTranslatable: true });
const player = (tracks = [track()]) => ({ playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: id, title: 'Synthetic video', author: 'Fixture channel', lengthSeconds: '8' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
const captions = { events: [
  { id: 1 },
  { tStartMs: 1234, dDurationMs: 2500, segs: [{ utf8: '>> First ' }, { utf8: 'caption\nline' }] },
  { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
  { tStartMs: 5000, dDurationMs: 1250, segs: [{ utf8: 'Café & literal <text>.' }] },
] };
function transport(...payloads) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    assert.ok(payloads.length, 'unexpected extra network request');
    const payload = payloads.shift();
    return payload instanceof Response ? payload : Response.json(payload);
  } };
}

test('accepts supported URLs and IDs without accepting lookalike hosts', () => {
  for (const input of [id, ` https://youtu.be/${id}?t=5 `,
    `https://www.youtube.com/watch?v=${id}&list=abc`, `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`, `https://youtube.com/live/${id}`]) {
    assert.equal(extractVideoId(input), id);
  }
  for (const input of ['', null, {}, 'short', `https://evilyoutube.com/watch?v=${id}`,
    `https://youtube.com.evil.test/watch?v=${id}`, `ftp://youtube.com/watch?v=${id}`,
    `https://user:secret@youtube.com/watch?v=${id}`, `https://example.test/${id}`]) {
    assert.throws(() => extractVideoId(input), { code: 'INVALID_INPUT' });
  }
});

test('track selection prefers manual English, then manual fallback, and honors explicit language', () => {
  const tracks = [track('en', 'asr'), track('de'), track('en'), track('fr', 'asr')];
  assert.equal(selectTrack(tracks), tracks[2]);
  assert.equal(selectTrack(tracks, 'fr'), tracks[3]);
  assert.equal(selectTrack(tracks.slice(0, 2), 'en'), tracks[0]);
  assert.equal(selectTrack([track('es', 'asr'), tracks[1]]), tracks[1]);
  assert.throws(() => selectTrack(tracks, 'ja'), { code: 'LANGUAGE_UNAVAILABLE' });
});

test('converts explicit millisecond timings to seconds and only removes caption debris', () => {
  assert.deepEqual(parseJson3(captions), [
    { start: 1.234, duration: 2.5, text: 'First caption line' },
    { start: 5, duration: 1.25, text: 'Café & literal <text>.' },
  ]);
});

test('rejects malformed timing/text and never reports empty captions as success', () => {
  for (const payload of [{}, { events: [null] }, { events: [{ segs: [{}] }] },
    { events: [{ tStartMs: -1, dDurationMs: 100, segs: [{ utf8: 'x' }] }] },
    { events: [{ tStartMs: '100', dDurationMs: 100, segs: [{ utf8: 'x' }] }] },
    { events: [{ tStartMs: 100, segs: [{ utf8: 'x' }] }] }]) {
    assert.throws(() => parseJson3(payload), { code: 'UPSTREAM_CHANGED' });
  }
  assert.throws(() => parseJson3({ events: [] }), { code: 'EMPTY_CAPTIONS' });
});

test('loads metadata and captions through two bounded credential-free requests', async () => {
  const io = transport(player(), captions);
  const result = await loadVideo(id, { fetch: io.fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.metadata.title, 'Synthetic video');
  assert.equal(result.metadata.source_url, `https://www.youtube.com/watch?v=${id}`);
  assert.equal(result.metadata.duration_seconds, 8);
  assert.equal(result.selected_track.is_generated, false);
  assert.deepEqual(result.segments, parseJson3(captions));
  assert.equal(io.calls.length, 2);
  assert.equal(JSON.parse(io.calls[0].options.body).videoId, id);
  assert.equal(new URL(io.calls[1].url).searchParams.get('fmt'), 'json3');
  for (const call of io.calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(result).includes('synthetic'), 'signed caption URL must not escape');
});

test('no-caption response retains metadata and makes no caption request', async () => {
  const io = transport(player([]));
  const result = await loadVideo(id, { fetch: io.fetch });
  assert.equal(result.status, 'no_captions');
  assert.equal(result.metadata.title, 'Synthetic video');
  assert.deepEqual(result.segments, []);
  assert.equal(io.calls.length, 1);
});

test('missing language does not silently download another language', async () => {
  const io = transport(player());
  await assert.rejects(loadVideo(id, { language: 'de', fetch: io.fetch }), { code: 'LANGUAGE_UNAVAILABLE' });
  assert.equal(io.calls.length, 1);
});

test('rejects untrusted caption destinations before sending a request', async () => {
  for (const baseUrl of ['http://www.youtube.com/api/timedtext', 'https://youtube.com.evil.test/api/timedtext',
    'https://127.0.0.1/api/timedtext', 'https://www.youtube.com:123/api/timedtext',
    'https://name:secret@www.youtube.com/api/timedtext', 'https://www.youtube.com/other']) {
    const io = transport(player([{ ...track(), baseUrl }]));
    await assert.rejects(loadVideo(id, { fetch: io.fetch }), { code: 'UPSTREAM_CHANGED' });
    assert.equal(io.calls.length, 1);
  }
});

test('distinguishes player denial, blocking, and unexpected response structures', async () => {
  for (const [payload, code] of [
    [{ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Confirm you are not a bot' } }, 'BLOCKED'],
    [{ playabilityStatus: { status: 'ERROR' } }, 'VIDEO_UNAVAILABLE'],
    [{}, 'UPSTREAM_CHANGED'],
    [{ ...player(), videoDetails: { videoId: 'wrong', title: 'Wrong' } }, 'UPSTREAM_CHANGED'],
    [{ ...player(), captions: {} }, 'UPSTREAM_CHANGED'],
    [player([null]), 'UPSTREAM_CHANGED'],
  ]) await assert.rejects(loadVideo(id, { fetch: transport(payload).fetch }), { code });
});

test('reports HTTP, network and empty-body failures without leaking response details', async () => {
  for (const [status, code] of [[429, 'BLOCKED'], [403, 'BLOCKED'], [500, 'HTTP_ERROR']]) {
    await assert.rejects(loadVideo(id, { fetch: transport(new Response('private upstream body', { status })).fetch }), { code });
  }
  await assert.rejects(loadVideo(id, { fetch: async () => { throw new Error('secret URL'); } }),
    error => error.code === 'NETWORK_ERROR' && !error.message.includes('secret'));
  await assert.rejects(loadVideo(id, { fetch: transport(player(), new Response('')).fetch }), { code: 'UPSTREAM_CHANGED' });
});

test('cancellation prevents the first request', async () => {
  const controller = new AbortController();
  controller.abort();
  const io = transport();
  await assert.rejects(loadVideo(id, { signal: controller.signal, fetch: io.fetch }), { code: 'CANCELLED' });
  assert.equal(io.calls.length, 0);
});

test('deadline cancels an in-flight request', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(loadVideo(id, { timeoutMs: 10, fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }), { code: 'TIMEOUT' });
  } finally { clearInterval(keepAlive); }
});

test('user cancellation interrupts the caption request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetch = async (_url, { signal }) => {
    if (++calls === 1) return Response.json(player());
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort();
    });
  };
  await assert.rejects(loadVideo(id, { signal: controller.signal, fetch }), { code: 'CANCELLED' });
  assert.equal(calls, 2);
});

test('invalid options fail before networking', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { language: '' }]) {
    await assert.rejects(loadVideo(id, { ...options, fetch: transport().fetch }), { code: 'INVALID_INPUT' });
  }
});
