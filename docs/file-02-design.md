# FILE-02 design — generated-file return

Status: draft for review. No implementation yet.

## Goal

An agent creates a file on its execution node and Qenbet returns it in the reply as a downloadable, hash-verified, previewable attachment — without assuming the Hub and the node share a filesystem.

Product requirement: **FILE-02** — “Return and preview generated files without assuming a shared filesystem across nodes,” with integrity and containment checks.

## What exists today

- Attachments are **upload-only**: four per message, 8 MiB each, seven media types, SHA-256 verified, room-bound, UUID-named files under `runtime/hub/attachments/`.
- A message stores `attachments: publicAttachment[]`; an attachment stores `messageId` once bound.
- Agent replies are **text only**. The ACP client keeps only `agent_message_chunk.content.text`; resource blocks are discarded.
- Remote agents speak ACP through an authenticated connector. There is no file-transfer channel, and the Hub never reads a remote workspace.

## Options considered

| Option | Verdict |
|---|---|
| **ACP `resource_link` / `resource` blocks** | Native, but harness support is inconsistent and a link is node-local. Useful as an optional accelerator later, not the baseline. |
| **MCP `share_file` tool** | Explicit and structured, but requires an MCP server plus per-agent configuration. Too much machinery for the first version. |
| **Parse paths out of the reply** | Brittle and unsafe. Rejected. |
| **Outbox directory convention** | Works with any harness that can write files, local or remote. Chosen. |

## Chosen contract: the outbox

Each agent workspace has a fixed `outbox/` directory.

1. Before a prompt, the Hub ensures `<workspace>/outbox/` exists.
2. The agent writes files there as part of its work. The user (or the agent’s own profile) is responsible for telling it to do so; Qenbet does not rewrite prompts in v1.
3. On **completed**, the Hub walks the outbox, validates and copies files into the attachment store, binds them to the reply message, then removes the delivered files.
4. On **failed / interrupted / unknown**, nothing is delivered. The outbox is left for diagnosis and quarantined at the next run.

Because each agent has a unique workspace and a FIFO queue, one outbox per agent is sufficient; executions do not overlap.

### Optional manifest

`outbox/manifest.json` may describe display names and media types:

```json
{
  "files": [
    { "path": "report.md", "name": "Q3 report.md", "mediaType": "text/markdown" }
  ]
}
```

If absent, the Hub infers `name` from the basename and `mediaType` from the extension. A manifest cannot widen limits or point outside the outbox; unknown or escaping entries are rejected.

### Limits

- At most **4** generated files per reply.
- At most **8 MiB** each; **16 MiB** total per reply.
- Same seven media types as uploads: TXT, MD, CSV, JSON, PDF, PNG, JPEG.
- Regular files only; hidden files, directories, symlinks, and FIFOs are rejected.
- Path depth at most 4 below `outbox/`.
- Duplicate display names are suffixed (`-2`).

Archives, logs, and arbitrary binaries are deliberately out of scope for v1; adding them later means a download-only type and a new limit review.

## Integrity and containment

- Resolve every candidate with `lstat`; reject symlinks and non-regular files.
- Resolve the real path and require it to stay under the real outbox path; reject `..`, absolute paths, and NUL bytes.
- Stream each file through SHA-256 while copying into the UUID store; enforce the byte cap during the copy, not after.
- Re-read the stored file and compare hash and size before publishing the attachment; on mismatch, delete the copy and surface an error.
- Generated attachments are immutable and download-only. The UI never renders agent-supplied HTML; images render as `<img>` from a blob URL, text previews are plain text.

## Data model

State version **8**, additive migration from v7.

Attachment gains:

```js
{
  origin: "upload" | "generated",
  agentId: string | null,      // generated only
  executionId: string | null,   // generated only
  width: number | null,         // optional image metadata
  height: number | null
}
```

Existing attachments migrate to `origin: "upload"` with null fields. Message `attachments` continues to use `publicAttachment`, which gains `origin`, `agentId`, and `executionId` for the generated badge.

The reply is created only after delivery succeeds or partially succeeds; delivery problems never discard the agent’s text answer.

## Flow

1. Execution queued.
2. At start: quarantine any leftover outbox from a previous failed attempt (`runtime/hub/generated-stale/<executionId>/`), then ensure an empty `outbox/`.
3. Agent runs and writes files.
4. On completion:
   - Walk and validate the outbox.
   - Copy and hash valid files; create attachment records and bind them to the reply.
   - Create the reply message with `attachments`.
   - Remove delivered files.
   - If some entries were rejected, append a visible warning event and a short room message naming them; do not fail the whole execution.
5. Emit `change`; the UI renders the card.

If delivery itself fails after the reply is saved (e.g., disk full), mark the execution `failed` with the delivery error and keep the reply text plus any already-bound files.

## UI

- Generated files appear on the agent reply as cards: icon, display name, size, short SHA-256, node tag, download.
- PNG/JPEG: inline thumbnail, loaded lazily from a blob URL; click opens the full download.
- Text/Markdown/CSV/JSON: a “Preview” disclosure showing at most the first 4 KiB, fetched from a bounded preview endpoint.
- PDFs: download only in v1.
- A `GENERATED` badge distinguishes agent output from user uploads.
- Cards stack at 390 px; inputs remain 16 px.

## API

- Reuse `GET /api/attachments/:id/download`.
- Add `GET /api/attachments/:id/preview` returning at most 4096 bytes as `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff`; only for text-like types.
- `publicAttachment` adds `origin`, `agentId`, `executionId`.

## Remote nodes

Phase 1 is local only; `local-fake`, `local-opencode`, and `local-acp` agents write to their own workspace.

Phase 2 extends the connector handshake (already versioned) with a **generated-files pull**:

1. After the prompt completes, the proxy asks the node to collect its outbox for that execution.
2. The node validates and hashes files under its own workspace, then streams metadata plus bytes with a bounded frame size.
3. The Hub writes them into its attachment store and verifies the hashes.
4. Node tokens, workspace containment, and size caps apply exactly as on the local path; the Hub never receives a raw path and never reads the node filesystem directly.

No shared filesystem is assumed. The remote acceptance case uses the fake Dell harness writing into its node outbox and the Hub retrieving identical bytes.

## Tests

Offline:

- Fake harness writes one file plus a manifest → attachment metadata, hash, size, message binding, download bytes.
- No outbox / empty outbox → ordinary text reply.
- Symlink, `..`, absolute path, hidden file, FIFO, depth > 4 → rejected with a visible warning.
- Oversize file, too many files, unsupported type, total cap → rejected; valid files still delivered.
- Duplicate names get suffixes.
- Failed execution leaves no attachment; next run quarantines the leftover.
- Restart: generated attachment still downloads; v7 → v8 migration defaults to upload.
- Upload paths unchanged.

Browser:

- Generated card, image thumbnail, text preview, download, `GENERATED` badge, 390 px layout, no overflow, no runtime exceptions.
- Real file input upload still passes.

Live:

- OpenCode writes `outbox/report.md` and replies; the Hub returns an attachment whose SHA-256 matches the file on disk.
- Remote fake Dell writes a file; the Hub retrieves identical bytes with no shared filesystem.
- Restart, download again, hash matches.

## Acceptance for FILE-02

FILE-02 moves to Done only when:

1. The local real-harness case returns a file with matching SHA-256 and a working preview.
2. The remote connector case returns identical bytes without a shared filesystem.
3. The browser report covers generated cards at desktop and 390 px.
4. The offline suite covers the rejection matrix and the v7 → v8 migration.

The M2 gate still requires a green REAL-SUP run; FILE-02 can be implemented before that, but cannot be marked Done while EXEC-03/04 remain Partial.

## Non-goals

- Browsing or syncing agent workspaces.
- Editing generated files in place.
- Streaming or resumable generated-file transfer.
- Files larger than 8 MiB, archives, or arbitrary binaries.
- Automatic prompt injection telling agents to use `outbox/` (documented convention in v1; a per-agent “return instructions” field can come later).

## Open questions

1. Should `manifest.json` be optional (recommended) or required for predictable names?
2. Should a failed execution’s outbox be quarantined (recommended) or deleted?
3. Do we need image dimensions in v1, or can the browser infer them?
4. Remote phase: one frame per file or a chunked stream?
5. Do we add a per-agent “files return to outbox/” hint in the editor, or rely on user prompts?

Estimated effort: local delivery plus UI **2–3 sessions**; remote connector **1–2 sessions**; live acceptance **1 session**.
