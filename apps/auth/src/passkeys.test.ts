import { assert, it } from "@effect/vitest";
import { passkeyOptions } from "./passkeys.ts";

it("requires a resident key and user verification", () => {
  assert.deepStrictEqual(passkeyOptions("https://notes.example.com").authenticatorSelection, {
    residentKey: "required",
    userVerification: "required",
  });
});

it("derives the relying party id and the origin from the public origin", () => {
  const options = passkeyOptions("https://notes.example.com");

  assert.strictEqual(options.rpID, "notes.example.com");
  assert.strictEqual(options.origin, "https://notes.example.com");
});

it("drops the port from the relying party id and keeps it in the origin", () => {
  const options = passkeyOptions("http://localhost:3000");

  assert.strictEqual(options.rpID, "localhost");
  assert.strictEqual(options.origin, "http://localhost:3000");
});
