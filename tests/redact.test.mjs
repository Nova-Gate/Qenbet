import test from "node:test";
import assert from "node:assert/strict";
import { redactError } from "../server/redact.mjs";

test("provider and connector credential shapes are redacted from errors", () => {
  const secrets = ["github_pat_FAKE123456789", "ghp_FAKE123456789", "sk-FAKE123456789", "fake-bearer-value", "fake-api-key", "fake-password"];
  const redacted = redactError(`github_pat_FAKE123456789 ghp_FAKE123456789 sk-FAKE123456789 Authorization: Bearer fake-bearer-value apiKey=fake-api-key password: fake-password`);
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test("JWTs, AWS access keys, and PEM private keys are redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----";
  const redacted = redactError(`jwt=${jwt} aws=${aws}\n${pem}`);
  assert.equal(redacted.includes(jwt), false);
  assert.equal(redacted.includes(aws), false);
  assert.equal(redacted.includes("MIIEowIBAAKCAQEA1234567890"), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED PRIVATE KEY\]/);
});
