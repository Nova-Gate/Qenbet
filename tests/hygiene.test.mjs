import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Hub } from "../server/hub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const fakeAgent = (directory) => ({
  id: "fake",
  name: "Fake",
  nodeId: "mac-mini",
  transport: "local-fake",
  workspace: join(directory, "workspace"),
  state: join(directory, "state"),
  centralWorkspace: join(directory, "central"),
  color: "yellow",
  enabled: true,
});

async function makeHub(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-hygiene-"));
  const hub = new Hub({ root, statePath: join(directory, "hub-state.json"), agents: [fakeAgent(directory)], ...options });
  await hub.load();
  return { hub, directory };
}

async function waitForStatus(hub, executionId, expected, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
    if (execution.status === expected) return execution;
    await delay(20);
  }
  throw new Error(`Execution did not reach ${expected}.`);
}

test("unused attachments can be deleted; sent ones cannot", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const uploaded = await hub.uploadAttachment("army", {
    name: "note.txt",
    mediaType: "text/plain",
    clientAttachmentId: "deletable",
    body: Readable.from([Buffer.from("delete me")]),
  });
  const removed = await hub.removeAttachment(uploaded.attachment.id);
  assert.equal(removed.removed, uploaded.attachment.id);
  assert.equal(hub.state.attachments.some((attachment) => attachment.id === uploaded.attachment.id), false);
  assert.equal(hub.state.attachmentReceipts["army:deletable"], undefined);
  await assert.rejects(hub.attachmentContent(uploaded.attachment.id), /not found/i);
  const sent = await hub.uploadAttachment("army", {
    name: "sent.txt",
    mediaType: "text/plain",
    clientAttachmentId: "sent",
    body: Readable.from([Buffer.from("send me")]),
  });
  await hub.post({ text: "@Fake hello", clientMessageId: "with-attachment", attachmentIds: [sent.attachment.id] });
  await assert.rejects(hub.removeAttachment(sent.attachment.id), /has been sent/i);
});

test("abandoned attachments expire and orphan bytes are collected", async (t) => {
  const { hub, directory } = await makeHub({ attachmentTtlMs: 1_000 });
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const fresh = await hub.uploadAttachment("army", {
    name: "fresh.txt",
    mediaType: "text/plain",
    clientAttachmentId: "fresh",
    body: Readable.from([Buffer.from("fresh")]),
  });
  const stale = await hub.uploadAttachment("army", {
    name: "stale.txt",
    mediaType: "text/plain",
    clientAttachmentId: "stale",
    body: Readable.from([Buffer.from("stale")]),
  });
  hub.state.attachments.find((attachment) => attachment.id === stale.attachment.id).createdAt = new Date(Date.now() - 10_000).toISOString();
  const orphanId = randomUUID();
  await writeFile(join(directory, "attachments", orphanId), "orphan bytes");
  const collected = await hub.collectAbandonedAttachments();
  assert.equal(collected.expired, 1);
  assert.ok(collected.orphans >= 1);
  assert.equal(hub.state.attachments.some((attachment) => attachment.id === stale.attachment.id), false);
  assert.ok(hub.state.attachments.some((attachment) => attachment.id === fresh.attachment.id));
  await assert.rejects(readFile(join(directory, "attachments", orphanId)), /ENOENT/);
});

test("the SSE endpoint emits a change event for a new post", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-sse-"));
  const agentsPath = join(directory, "agents.json");
  await writeFile(agentsPath, `${JSON.stringify([fakeAgent(directory)], null, 2)}\n`);
  const child = spawn(process.execPath, [
    join(root, "server/server.mjs"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--state", join(directory, "hub-state.json"),
    "--agents", agentsPath,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(5_000)]);
    }
    await rm(directory, { recursive: true, force: true });
  });
  let base;
  const startup = Date.now();
  while (!base) {
    const line = output.split("\n").find((value) => value.includes("qenbet.ready"));
    if (line) { base = new URL(JSON.parse(line).url); break; }
    if (Date.now() - startup > 10_000) throw new Error(`Server did not start: ${output}`);
    await delay(25);
  }
  const response = await fetch(new URL("/api/events", base));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let events = "";
  const readChanges = async (count, timeout = 8_000) => {
    const started = Date.now();
    while ((events.match(/event: change/g) ?? []).length < count) {
      if (Date.now() - started > timeout) throw new Error(`SSE change event timed out: ${events}`);
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed early");
      events += decoder.decode(value, { stream: true });
    }
  };
  await readChanges(1);
  const posted = await fetch(new URL("/api/messages", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "sse probe", clientMessageId: "sse-probe", roomId: "army" }),
  });
  assert.equal(posted.status, 202);
  await readChanges(2);
  await reader.cancel();
});

test("ACP clients do not retain notifications across prompts", { timeout: 20_000 }, async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const first = await hub.post({ text: "@Fake hello", clientMessageId: "notify-1" });
  await waitForStatus(hub, first.executions[0].id, "completed");
  const client = hub.runtime.clients.get("fake");
  assert.equal(client.notifications.length, 0);
  const second = await hub.post({ text: "@Fake again", clientMessageId: "notify-2" });
  await waitForStatus(hub, second.executions[0].id, "completed");
  assert.equal(client.notifications.length, 0);
});
