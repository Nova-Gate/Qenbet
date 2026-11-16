import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  await assert.rejects(readFile(join(directory, "attachments", uploaded.attachment.id)), /ENOENT/);
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
  assert.equal(collected.orphans, 0, "a fresh orphan is inside the grace window");
  assert.equal(await readFile(join(directory, "attachments", orphanId), "utf8"), "orphan bytes");
  assert.equal(hub.state.attachments.some((attachment) => attachment.id === stale.attachment.id), false);
  assert.ok(hub.state.attachments.some((attachment) => attachment.id === fresh.attachment.id));
  const bootPass = await hub.collectAbandonedAttachments(Date.now(), { orphanOlderThanMs: 0 });
  assert.ok(bootPass.orphans >= 1);
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

test("the attachment sweep expires unsent uploads without a restart", { timeout: 10_000 }, async (t) => {
  const { hub, directory } = await makeHub({ attachmentTtlMs: 50, attachmentGcIntervalMs: 50 });
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const uploaded = await hub.uploadAttachment("army", {
    name: "sweep.txt",
    mediaType: "text/plain",
    clientAttachmentId: "sweep",
    body: Readable.from([Buffer.from("sweep me")]),
  });
  await delay(400);
  assert.equal(hub.state.attachments.some((attachment) => attachment.id === uploaded.attachment.id), false);
  await assert.rejects(readFile(join(directory, "attachments", uploaded.attachment.id)), /ENOENT/);
});

test("temporary upload files are removed at boot and after ageing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-temporary-"));
  const attachments = join(directory, "attachments");
  await mkdir(attachments, { recursive: true });
  const bootTemp = `${randomUUID()}.111.${randomUUID()}.tmp`;
  await writeFile(join(attachments, bootTemp), "partial upload");
  const hub = new Hub({ root, statePath: join(directory, "hub-state.json"), agents: [fakeAgent(directory)] });
  await hub.load();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(readFile(join(attachments, bootTemp)), /ENOENT/);
  const oldTemp = `${randomUUID()}.222.${randomUUID()}.tmp`;
  const freshTemp = `${randomUUID()}.333.${randomUUID()}.tmp`;
  await writeFile(join(attachments, oldTemp), "old partial");
  await writeFile(join(attachments, freshTemp), "fresh partial");
  const past = new Date(Date.now() - 7_200_000);
  await utimes(join(attachments, oldTemp), past, past);
  const collected = await hub.collectAbandonedAttachments(Date.now(), { temporaryOlderThanMs: 3_600_000 });
  assert.equal(collected.temporaries, 1);
  await assert.rejects(readFile(join(attachments, oldTemp)), /ENOENT/);
  assert.equal(await readFile(join(attachments, freshTemp), "utf8"), "fresh partial");
});

test("receipts pointing at missing attachments are dropped", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  hub.state.attachmentReceipts["army:ghost"] = randomUUID();
  const collected = await hub.collectAbandonedAttachments();
  assert.equal(collected.receipts, 1);
  assert.equal(hub.state.attachmentReceipts["army:ghost"], undefined);
});

test("a failed sweep save leaves the attachment bytes in place", async (t) => {
  const { hub, directory } = await makeHub({ attachmentTtlMs: 1 });
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const uploaded = await hub.uploadAttachment("army", {
    name: "keep.txt",
    mediaType: "text/plain",
    clientAttachmentId: "keep",
    body: Readable.from([Buffer.from("keep me")]),
  });
  hub.state.attachments.find((attachment) => attachment.id === uploaded.attachment.id).createdAt = new Date(Date.now() - 60_000).toISOString();
  const original = hub.save.bind(hub);
  hub.save = async () => {
    hub.save = original;
    throw new Error("simulated save failure");
  };
  await assert.rejects(hub.collectAbandonedAttachments(), /simulated save failure/);
  assert.ok(hub.state.attachments.some((attachment) => attachment.id === uploaded.attachment.id));
  assert.equal((await readFile(join(directory, "attachments", uploaded.attachment.id))).length > 0, true);
});

test("a sweep that lists during an upload keeps the new file", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const originalList = hub.attachmentStore.list.bind(hub.attachmentStore);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  hub.attachmentStore.list = async (olderThanMs = 0) => {
    await gate;
    return originalList(olderThanMs);
  };
  const sweep = hub.collectAbandonedAttachments(Date.now(), { temporaryOlderThanMs: 0, orphanOlderThanMs: 0 });
  const uploaded = await hub.uploadAttachment("army", {
    name: "race.txt",
    mediaType: "text/plain",
    clientAttachmentId: "race",
    body: Readable.from([Buffer.from("race bytes")]),
  });
  release();
  await sweep;
  hub.attachmentStore.list = originalList;
  const content = await hub.attachmentContent(uploaded.attachment.id);
  assert.equal(content.content.toString("utf8"), "race bytes");
});
