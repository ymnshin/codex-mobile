import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveText } from "../src/util/redaction.js";

test("redacts known secret patterns", () => {
  const input =
    'Authorization: Bearer abcdefghijklmnop sk-12345678901234567890 OPENAI_API_KEY=secret C:\\Users\\me\\.codex\\auth.json';
  const output = redactSensitiveText(input);

  assert.equal(output.includes("secret"), false);
  assert.equal(output.includes("sk-12345678901234567890"), false);
  assert.equal(output.includes("auth.json"), true);
  assert.match(output, /\[redacted]/);
});

test("redacts multiline private key blocks", () => {
  const input = [
    "before",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE",
    "-----END OPENSSH PRIVATE KEY-----",
    "after"
  ].join("\n");

  const output = redactSensitiveText(input);

  assert.equal(output.includes("OPENSSH PRIVATE KEY"), false);
  assert.equal(output.includes("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE"), false);
  assert.match(output, /\[redacted private key block\]/);
});

test("redacts private key blocks inside JSON-stringified payloads", () => {
  const input = JSON.stringify(
    {
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----"
    },
    null,
    2
  );

  const output = redactSensitiveText(input);

  assert.equal(output.includes("RSA PRIVATE KEY"), false);
  assert.equal(output.includes("abc123"), false);
  assert.match(output, /\[redacted private key block\]/);
});

test("redacts structured key-value secrets and cookie-style values", () => {
  const input = [
    '{"token":"abc1234567890secret","access_token":"refreshable-secret"}',
    "Cookie: sessionid=abc1234567890secret; csrftoken=csrf-secret",
    "aws_access_key_id=AKIA1234567890ABCDEF"
  ].join("\n");

  const output = redactSensitiveText(input);

  assert.equal(output.includes("abc1234567890secret"), false);
  assert.equal(output.includes("refreshable-secret"), false);
  assert.equal(output.includes("csrftoken=csrf-secret"), false);
  assert.equal(output.includes("AKIA1234567890ABCDEF"), false);
  assert.match(output, /"token":"\[redacted\]"/);
  assert.match(output, /"access_token":"\[redacted\]"/);
  assert.match(output, /\[redacted cookie header\]/);
  assert.match(output, /aws_access_key_id=\[redacted\]/);
});

test("redacts raw Discord bot tokens", () => {
  const input = "discord token MTIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.mnopqrstuvwxyzABCDEFGHIJKLMN";
  const output = redactSensitiveText(input);

  assert.equal(output.includes("MTIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.mnopqrstuvwxyzABCDEFGHIJKLMN"), false);
  assert.match(output, /\[redacted\]/);
});
