# YouTube Transcript Notes — Obsidian plugin

Desktop-only first release. Import a public YouTube URL into ordinary Markdown
transcript and summary notes in a selected folder of the current vault. Requires
Obsidian 1.12.3 or later. No Python, server, or separate Node installation is needed
by the plugin user. The plugin uses desktop Obsidian's built-in Node HTTPS support.

## Install

Build from this repository with Node.js 22 or later and npm:

```sh
npm ci
npm test
npm run build
```

Copy the **youtube-transcript-notes** folder from `dist/` into your vault's
`.obsidian/plugins/` directory. It contains `main.js`, `manifest.json`, and
`styles.css`. Reload Obsidian and enable **YouTube Transcript Notes** under
Settings → Community plugins. This plugin has its own ID and does not replace
other installed YouTube plugins. No settings or API keys are bundled.

## Use

1. In plugin settings, select or type a destination folder inside the current
   vault. The picker lists folder names only. It is created on import if necessary.
2. For summaries, choose or create an OpenRouter API key in Obsidian's secret
   selector. Only its name is saved in this plugin's `data.json`.
3. Select the model and press **Test settings**. This makes one small paid request
   using the selected parameters, including search when enabled. It displays the
   returned model, elapsed time, reported cost, and returned web-source count.
4. Click the YouTube ribbon icon (**Import YouTube notes**) or use the command
   palette. Paste a URL, choose Transcript, Summary, or Both, and click **Create transcript**, **Create summary**, or **Create notes**.
   The dialog shows the destination and summary settings before you start.
5. Once saved, choose **Open summary**, **Open transcript**, or **Done**.
   Both creates two linked notes; nothing opens behind the popup.

Transcript-only imports need no API key. Public watch/share/Shorts/live/embed
URLs and video IDs are accepted. Playback offsets do not trim the transcript.
Captions are not audio transcription. Unavailable/private/restricted videos and
videos with no exposed captions may not work.

The default is Luna, 16,384 maximum output tokens, provider-default temperature,
brief overview, and web search off. Users can edit the model ID, token ceiling,
temperature, prompt, caption language, summary detail, and web-search settings.
Detailed notes explicitly request chapter coverage and important concessions;
it remains a model instruction, not a guarantee of exhaustive coverage.

To correct captions, edit the transcript note while keeping its `## Transcript`
heading and timestamp-prefixed paragraphs. Run **Summarize current transcript
note** from that note's editor. The current editor text is sent; a new summary
is created and the transcript is not overwritten. Plain timestamps or the
plugin's timestamp links are accepted. Unrecognized paragraphs fail explicitly
instead of being silently dropped. This command is available in editing mode.

## Preservation and recovery

- Existing notes directly in the selected destination folder are detected by
  their `youtube_video_id` property. Other folders are not scanned. Open an
  existing note or create another copy. This version never replaces a note.
- Filename collisions get a numbered pair. Vault create operations still refuse
  an existing path if another writer races the import.
- Both saves the transcript before requesting a summary. If the summary fails,
  retry from the same popup without fetching the captions again.
- Summary-only failures offer **Save transcript instead**. Retrieved text remains
  in memory while the popup stays open.
- If generation succeeds but saving fails, the answer stays in memory for
  **Retry saving**, avoiding another paid request unless settings change.
- Cancellation aborts the network request. It cannot undo provider usage already
  processed or notes already saved. Closing the popup discards unsaved in-memory
  results; saved notes remain. Closing during a request or with an unsaved generated
  summary asks for confirmation. Plugin unload also aborts active requests.
- A backlink is added to a newly saved transcript only if it has not been edited
  since this import created it. A user's concurrent edits take precedence.

## Context, search, and costs

Each summary sends only the active video's metadata, full timestamped transcript,
custom prompt, and bundled general spelling glossary to OpenRouter and the model
provider. No other vault notes, chat, `.env`, or browser cookies are sent.
Provider privacy policies apply. SecretStorage is vault-local Obsidian storage;
it should not be described as end-to-end encrypted or inaccessible to plugins.

Web verification explicitly enables OpenRouter's **Exa** web plugin, with 1–5
results. It requests a separate cited fact/spelling-check section and preserves
the speaker's claims and original transcript. Safe provider citation annotations
are retained in a separate source list. A returned source does not prove every
claim was checked. No returned sources must not be presented as successful
comprehensive verification. Search and input/output tokens incur charges; even
failed or cancelled requests may be charged. There is no automatic model fallback
or retry. Provider errors are sanitized so raw error bodies never expose keys.

The full source cap is 300,000 characters; over-limit sources fail before sending.
There is no automatic chunking. Model context limits may be lower. Output ceiling
is configurable from 128 to 65,536 tokens; models may reject unsupported values.
The provider has a 300-second deadline. Temperature is omitted when blank, useful
for models such as Luna/Astra. Model availability and pricing can change.

## Architecture and validation

`src/main.js` owns Obsidian UI, settings, vault writes, and secret lookup.
`src/core.mjs` owns portable note formatting, edited-transcript parsing, validation,
and prompt overrides. `src/transport.mjs` uses cancellable Node HTTPS with a
provider allowlist, no redirects, no cookies, and a response-size limit.
`src/retrieval.mjs` and `src/summary.mjs` handle caption retrieval and OpenRouter
requests. The bundled prompt and spelling glossary live in `prompts/`. All build
inputs are in this repository; no sibling checkout is needed. Build products and
local evaluation notes are ignored. The build also writes `main.js` at the
repository root for build verification.

`npm test` runs the plugin workflow, note formatting, retrieval, and summary tests.

Tests are synthetic and never read credentials or make paid requests. Actual
network and host acceptance evidence is kept in ignored `.state/`. Mobile,
marketplace submission, billing/licensing, bulk imports, chat, automatic sync,
and transcription of videos without captions are outside this first release.

References: [Obsidian secret storage](https://docs.obsidian.md/plugins/guides/secret-storage),
[OpenRouter web search](https://openrouter.ai/docs/guides/features/plugins/web-search).

## Support development

If this tool is useful to you, you can [buy me a coffee](https://www.buymeacoffee.com/8xewoxol8o).

## Repository origin

This is the standalone home of the Obsidian plugin, extracted from
[YouTube Transcript](https://github.com/blossomz37/youtube-transcript) at commit
`1787656`. It retains the plugin ID `youtube-transcript-notes`, so existing vault settings and notes remain compatible.
The browser and macOS apps continue in the original repository.

## Releases and provenance

Pushing a version tag matching `manifest.json` (for example, `0.1.3`) runs the
release workflow: clean install, tests, build, GitHub artifact attestations,
then publication of `main.js`, `manifest.json`, and `styles.css`. All three assets
are attested before upload. Releases before 0.1.3 do not have attestations.

After downloading release assets, verify them with the GitHub CLI:

```sh
gh attestation verify main.js -R blossomz37/youtube-transcript-obsidian
gh attestation verify manifest.json -R blossomz37/youtube-transcript-obsidian
gh attestation verify styles.css -R blossomz37/youtube-transcript-obsidian
```

## License

[MIT](LICENSE) © 2026 Carlo Santiago.
