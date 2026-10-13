import assert from "node:assert/strict";
import { b64url, encryptPayload, generateVapidKeys, sendPush, unb64url } from "./webpush.ts";

const enc = new TextEncoder();
const B = (u: Uint8Array) => u as unknown as BufferSource;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", B(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: B(salt), info: B(info) }, key, bytes * 8));
}

/** Receiver side of RFC 8291 (what the browser does), to round-trip our output. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  assert.equal(rs, 4096);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", B(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", B(cek), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: B(nonce) }, aes, B(cipher)));
  assert.equal(plain[plain.length - 1], 2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function subscriber() {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  return { ua, auth, sub: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: b64url(p256dh), auth: b64url(auth) } } };
}

Deno.test("web push payload round-trips through RFC 8291 decryption", async () => {
  const { ua, auth, sub } = await subscriber();
  const msg = JSON.stringify({ title: "Ισοζύγιο ΦΠΑ", body: "Πληρωτέο 1.709,12 €" });
  const body = await encryptPayload(sub, enc.encode(msg));
  assert.equal(await decrypt(body, ua, auth), msg);
});

Deno.test("b64url round trip", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  assert.deepEqual(unb64url(b64url(bytes)), bytes);
});

Deno.test("sendPush: VAPID header verifies with the public key; 410 marks subscription gone", async () => {
  const keys = await generateVapidKeys();
  assert.equal(unb64url(keys.publicKey).length, 65);
  const { ua, auth, sub } = await subscriber();
  let seen: Request | null = null;
  let seenBody = new Uint8Array();
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = new Request(url, init);
    seenBody = new Uint8Array(await seen.clone().arrayBuffer());
    return new Response(null, { status: 410 });
  }) as typeof fetch;

  const res = await sendPush(sub, { title: "t", body: "b" }, keys, "mailto:me@example.com", fakeFetch);
  assert.deepEqual(res, { ok: false, gone: true, status: 410 });

  const authz = seen!.headers.get("authorization")!;
  const [, jwt, k] = authz.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, keys.publicKey);
  const [h, p, s] = jwt.split(".");
  const claims = JSON.parse(new TextDecoder().decode(unb64url(p)));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "mailto:me@example.com");
  const pub = await crypto.subtle.importKey("raw", B(unb64url(keys.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, B(unb64url(s)), B(enc.encode(`${h}.${p}`))));
  assert.equal(seen!.headers.get("content-encoding"), "aes128gcm");
  assert.equal(JSON.parse(await decrypt(seenBody, ua, auth)).title, "t");
});
