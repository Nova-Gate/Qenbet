import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../server/hub.mjs";
import { formatArguments, parseArguments } from "../web/args.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "connectors/remote-acp/fake-harness.mjs");
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function makeHub() {
  const directory = await mkdtemp(join(tmpdir(), "qenbet-acp-"));
  const hub = new Hub({ root, statePath: join(directory, "hub-state.json"), agents: [] });
  await hub.load();
  return { hub, directory };
}

function customAgent(directory, overrides = {}) {
  return {
    name: "Custom Fake",
    nodeId: "mac-mini",
    transport: "local-acp",
    command: process.execPath,
    args: [harness],
    env: {
      QENBET_NODE_ID: "mac-mini",
      QENBET_AGENT_TITLE: "Custom Fake",
      QENBET_WORKSPACE: join(directory, "custom-workspace"),
      QENBET_STATE_ROOT: join(directory, "custom-state"),
    },
    centralWorkspace: join(directory, "custom-central"),
    ...overrides,
  };
}

async function waitForStatus(hub, executionId, expected, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const execution = hub.state.executions.find((candidate) => candidate.id === executionId);
    if (execution.status === expected) return execution;
    await delay(25);
  }
  throw new Error(`Execution did not reach ${expected}.`);
}

test("arguments parse shell-style quoting", () => {
  assert.deepEqual(parseArguments(""), []);
  assert.deepEqual(parseArguments("acp --flag value"), ["acp", "--flag", "value"]);
  assert.deepEqual(parseArguments(`"/Applications/DeepSeek Harness.app/bin" --profile acp`), ["/Applications/DeepSeek Harness.app/bin", "--profile", "acp"]);
  assert.deepEqual(parseArguments(`'single quoted' plain`), ["single quoted", "plain"]);
  assert.deepEqual(parseArguments(`one\\ two three`), ["one two", "three"]);
  assert.deepEqual(parseArguments(`"a \\"b\\""`), ['a "b"']);
  assert.deepEqual(formatArguments(["a b", "plain", 'q"uote']), `"a b" plain "q\\"uote"`);
  assert.deepEqual(parseArguments(formatArguments(["a b", "plain", 'q"uote'])), ["a b", "plain", 'q"uote']);
  assert.throws(() => parseArguments(`"unterminated`), /Unterminated quote/);
  assert.throws(() => parseArguments("trailing\\"), /Trailing backslash/);
});

test("a custom ACP agent runs through its command, args, and environment", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const agent = await hub.createAgent(customAgent(directory));
  assert.equal(agent.transport, "local-acp");
  assert.deepEqual(agent.args, [harness]);
  assert.equal(agent.env.QENBET_NODE_ID, "mac-mini");

  const health = await hub.testAgent(agent.id);
  assert.equal(health.status, "available", JSON.stringify(health));

  const posted = await hub.post({ text: "@Custom Fake hello", clientMessageId: "custom-1" });
  const execution = await waitForStatus(hub, posted.executions[0].id, "completed");
  const reply = hub.state.messages.find((message) => message.id === execution.resultMessageId);
  assert.match(reply.text, /Execution node: mac-mini/);
  assert.match(reply.text, /deterministic offline response/);
  const proof = JSON.parse(await readFile(join(directory, "custom-workspace", "execution-proof.json"), "utf8"));
  assert.equal(proof.nodeId, "mac-mini");

  const persisted = JSON.parse(await readFile(join(directory, "hub-state.json"), "utf8"));
  const saved = persisted.agentDefinitions.find((candidate) => candidate.id === agent.id);
  assert.deepEqual(saved.args, [harness]);
  assert.equal(saved.env.QENBET_AGENT_TITLE, "Custom Fake");
});

test("presentation edits keep the custom ACP session; execution edits reset it", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const agent = await hub.createAgent(customAgent(directory));
  const posted = await hub.post({ text: "@Custom Fake hello", clientMessageId: "session-1" });
  await waitForStatus(hub, posted.executions[0].id, "completed");
  const sessionBefore = hub.state.agents.find((candidate) => candidate.id === agent.id).sessionId;
  assert.ok(sessionBefore);
  const payload = {
    name: agent.name,
    nodeId: agent.nodeId,
    transport: agent.transport,
    command: agent.command,
    args: [...agent.args],
    env: { ...agent.env },
    centralWorkspace: agent.centralWorkspace,
    color: "pink",
    enabled: true,
  };
  await hub.updateAgent(agent.id, payload);
  assert.equal(hub.state.agents.find((candidate) => candidate.id === agent.id).sessionId, sessionBefore);
  await hub.updateAgent(agent.id, { ...payload, args: [...agent.args, "--extra"] });
  assert.equal(hub.state.agents.find((candidate) => candidate.id === agent.id).sessionId, null);
});

test("custom ACP validation rejects missing commands, bad arguments, and secrets", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(hub.createAgent(customAgent(directory, { command: "" })), /require a command and workspace/);
  await assert.rejects(hub.createAgent(customAgent(directory, { args: "acp" })), /Arguments must be a list/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { "BAD NAME": "x" } })), /Invalid environment name/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { GEMINI_API_KEY: "secret" } })), /looks like a credential/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { AWS_SECRET_ACCESS_KEY: "secret" } })), /looks like a credential/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { OPENAI_KEY: "secret" } })), /looks like a credential/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { AWS_ACCESS_KEY_ID: "secret" } })), /looks like a credential/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { SAFE_FLAG: "sk-1234567890abcdef" } })), /looks like a credential/);
  await assert.rejects(hub.createAgent(customAgent(directory, { args: ["--api-key", "value"] })), /must not carry provider secrets/);
  await assert.rejects(hub.createAgent(customAgent(directory, { args: ["AKIAABCDEFGHIJKLMNOP"] })), /must not carry provider secrets/);
  await assert.rejects(hub.createAgent(customAgent(directory, { env: { FLAG: 1 } })), /must be text/);
  const spaced = await hub.createAgent(customAgent(directory, { name: "Spaced", args: ["", "  kept  "], centralWorkspace: join(directory, "spaced-central") }));
  assert.deepEqual(spaced.args, ["", "  kept  "]);
});

test("custom ACP workspaces are unique", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  await hub.createAgent(customAgent(directory));
  await assert.rejects(hub.createAgent(customAgent(directory, { name: "Second" })), /already owns that workspace/);
});

test("a bad custom command fails the connectivity check loudly", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const agent = await hub.createAgent(customAgent(directory, { command: join(directory, "missing-binary") }));
  const health = await hub.testAgent(agent.id);
  assert.equal(health.status, "misconfigured");
  assert.match(health.error, /ENOENT/);
});

test("the custom command receives the configured arguments and environment", async (t) => {
  const { hub, directory } = await makeHub();
  t.after(async () => { await hub.stop(); await rm(directory, { recursive: true, force: true }); });
  const probe = join(directory, "probe.mjs");
  await writeFile(probe, [
    `import { stdin } from "node:process";`,
    `stdin.once("data", () => {`,
    `  process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.QENBET_PROBE }) + "\\n");`,
    `  process.exit(1);`,
    `});`,
  ].join("\n"));
  const agent = await hub.createAgent(customAgent(directory, {
    command: process.execPath,
    args: [probe, "--flag", "two words"],
    env: { QENBET_PROBE: "probe-value" },
  }));
  const health = await hub.testAgent(agent.id);
  assert.notEqual(health.status, "available", JSON.stringify(health));
  assert.match(health.error, /--flag/);
  assert.match(health.error, /two words/);
  assert.match(health.error, /probe-value/);
});
