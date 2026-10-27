/**
 * Exercises the authoring access layer, which needs no database: the public
 * key configuration, the capability token verifier, the permission system Lumi
 * consults, and the middleware that turns an Authorization header into a user.
 *
 * Tokens are signed here with freshly generated Ed25519 keys, standing in for
 * Conductor. Nothing is shared with Conductor's code.
 */
import express from "express";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// Test fixtures, not defaults. Importing the request-user middleware loads
// `h5p.js`, which imports the service config. `||=` so an operator can point
// the harness at real configuration.
process.env.MONGODB_URL ||= "mongodb://unused";
process.env.S3_CONTENT_BUCKET ||= "unused";
process.env.S3_LIBRARY_BUCKET ||= "unused";
process.env.S3_TEMPORARY_BUCKET ||= "unused";
process.env.AWS_REGION ||= "us-west-2";
process.env.BASE_URL ||= "https://verify.example.test";
process.env.ALLOWED_EMBED_PARENT_ORIGINS ||= "https://parent.example.test";
process.env.EMBED_FRAME_ANCESTORS ||= "https://*.example.test";
process.env.EMBED_ADAPT_REFERRERS ||= "https://adapt.example.test";
process.env.EMBED_TRUSTED_PARENT_HOSTS ||= "trusted.example.test";

const { requiredEd25519PublicKeySet } = await import("../dist/config/env.js");
const { createCapabilityVerifier, CapabilityTokenError } = await import("../dist/auth/capabilityToken.js");
const { default: CapabilityPermissionSystem } = await import("../dist/auth/CapabilityPermissionSystem.js");
const { capabilityUserMiddleware } = await import("../dist/auth/requestUser.js");
const { ContentPermission, GeneralPermission, TemporaryFilePermission } = await import("@lumieducation/h5p-server");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
}

// ------------------------------------------------------------ keys
const current = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const next = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const stranger = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const publicJwk = async (pair, kid) => ({ ...(await exportJWK(pair.publicKey)), kid });
const currentJwk = await publicJwk(current, "2026-10-a");
const nextJwk = await publicJwk(next, "2026-10-b");

function readKeys(value) {
  process.env.__KEYS_PROBE = value;
  try {
    return { keys: requiredEd25519PublicKeySet("__KEYS_PROBE") };
  } catch (err) {
    return { error: err.message };
  } finally {
    delete process.env.__KEYS_PROBE;
  }
}
check("accepts a JWK set of public Ed25519 keys", readKeys(JSON.stringify({ keys: [currentJwk, nextJwk] })).keys?.length === 2);
const privateJwk = { ...(await exportJWK(current.privateKey)), kid: "oops" };
check("refuses a private key in configuration", /private key/.test(readKeys(JSON.stringify({ keys: [privateJwk] })).error ?? ""));
check("refuses a key without kid", /kid/.test(readKeys(JSON.stringify({ keys: [{ ...currentJwk, kid: undefined }] })).error ?? ""));
check("refuses duplicate kids", /two keys/.test(readKeys(JSON.stringify({ keys: [currentJwk, { ...nextJwk, kid: currentJwk.kid }] })).error ?? ""));
check("refuses a non-Ed25519 key", /Ed25519/.test(readKeys(JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b", kid: "ec" }] })).error ?? ""));
check("refuses an empty set", /at least one/.test(readKeys(JSON.stringify({ keys: [] })).error ?? ""));
check("refuses unparseable JSON", /unparseable/.test(readKeys("{keys:").error ?? ""));

// ------------------------------------------------------------ tokens
const verify = createCapabilityVerifier([currentJwk, nextJwk]);
const now = Math.floor(Date.now() / 1000);

async function sign(claims = {}, { pair = current, kid = currentJwk.kid, alg = "EdDSA", iat = now, exp = now + 900, omit = [] } = {}) {
  const body = { sub: "11111111-1111-4111-8111-111111111111", act: ["edit"], cid: "31483", jti: crypto.randomUUID(), ...claims };
  for (const k of omit) delete body[k];
  const jwt = new SignJWT(body).setProtectedHeader({ alg, ...(kid ? { kid } : {}) });
  if (!omit.includes("iss")) jwt.setIssuer("conductor");
  if (!omit.includes("aud")) jwt.setAudience("h5p-service");
  if (!omit.includes("iat")) jwt.setIssuedAt(iat);
  if (!omit.includes("exp")) jwt.setExpirationTime(exp);
  return jwt.sign(pair.privateKey);
}

async function reason(tokenPromise) {
  try {
    await verify(await tokenPromise);
    return "accepted";
  } catch (err) {
    return err instanceof CapabilityTokenError ? err.reason : `unexpected: ${err.message}`;
  }
}

const accepted = await verify(await sign());
check("a valid edit token verifies", accepted.subject === "11111111-1111-4111-8111-111111111111" && accepted.contentId === "31483" && accepted.actions.has("edit"));
check("the token id is kept for audit", typeof accepted.tokenId === "string" && accepted.tokenId.length > 0);
check("a numeric cid normalises to Lumi's string id", (await verify(await sign({ cid: 31483 }))).contentId === "31483");
check("a token from the next key verifies during rotation", (await reason(sign({}, { pair: next, kid: nextJwk.kid }))) === "accepted");
check("a create token needs no cid", (await reason(sign({ act: ["create"], cid: undefined }, { omit: ["cid"] }))) === "accepted");

const cases = [
  ["expired token", sign({}, { iat: now - 1000, exp: now - 100 }), "expired"],
  ["token issued over 16 minutes ago, whatever its exp says", sign({}, { iat: now - 17 * 60, exp: now + 3600 }), "expired"],
  ["signed by a key it does not name", sign({}, { pair: stranger, kid: currentJwk.kid }), "bad-signature"],
  ["unknown kid", sign({}, { pair: stranger, kid: "nobody" }), "unknown-key"],
  ["no kid", sign({}, { kid: null }), "unknown-key"],
  ["wrong audience", sign({ aud: "someone-else" }, { omit: ["aud"] }), "bad-claims"],
  ["wrong issuer", sign({ iss: "attacker" }, { omit: ["iss"] }), "bad-claims"],
  ["no jti", sign({}, { omit: ["jti"] }), "bad-claims"],
  ["no exp", sign({}, { omit: ["exp"] }), "bad-claims"],
  ["unknown action", sign({ act: ["edit", "admin"] }), "bad-claims"],
  ["empty action list", sign({ act: [] }), "bad-claims"],
  ["edit without a cid", sign({}, { omit: ["cid"] }), "bad-claims"],
  ["delete without a cid", sign({ act: ["delete"] }, { omit: ["cid"] }), "bad-claims"],
  ["cid with trailing space", sign({ cid: "12 " }), "bad-claims"],
  ["cid in exponent form", sign({ cid: "1e3" }), "bad-claims"],
  ["cid of zero", sign({ cid: "0" }), "bad-claims"],
  ["empty sub", sign({ sub: "" }), "bad-claims"],
];
for (const [name, token, expected] of cases) {
  const got = await reason(token);
  check(`refuses ${name}`, got === expected, `got ${got}`);
}
check("refuses an unsigned token", (await reason(Promise.resolve(
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", act: ["edit"], cid: "1", iss: "conductor", aud: "h5p-service", iat: now, exp: now + 60, jti: "j" })).toString("base64url")}.`
))) !== "accepted");
check("refuses garbage", (await reason(Promise.resolve("not.a.token"))) !== "accepted");

// ------------------------------------------------------------ permissions
const ps = new CapabilityPermissionSystem();
const anon = { id: "anonymous", name: "Anonymous", email: "", type: "local" };
const asUser = async (claims) => ({ id: "u", name: "u", email: "", type: "local", capability: await verify(await sign(claims)) });
const editor12 = await asUser({ act: ["edit"], cid: "12" });
const deleter12 = await asUser({ act: ["delete"], cid: "12" });
const creator = await asUser({ act: ["create"], cid: undefined });
const librarian = await asUser({ act: ["libraries"], cid: undefined });

for (const p of ["View", "Embed", "Download"]) {
  check(`anonymous keeps ${p}, as in phase 1`, await ps.checkForContent(anon, ContentPermission[p], "12"));
}
check("anonymous cannot edit", !(await ps.checkForContent(anon, ContentPermission.Edit, "12")));
check("anonymous cannot delete", !(await ps.checkForContent(anon, ContentPermission.Delete, "12")));
check("anonymous cannot upload temporary files", !(await ps.checkForTemporaryFile(anon, TemporaryFilePermission.Create, undefined)));
check("anonymous can read a temporary file by name (img previews)", await ps.checkForTemporaryFile(anon, TemporaryFilePermission.View, "images/a-AbCd1234.png"));
check("anonymous cannot install libraries", !(await ps.checkForGeneralAction(anon, GeneralPermission.InstallRecommended)));
check("an edit token edits its own content id", await ps.checkForContent(editor12, ContentPermission.Edit, "12"));
check("an edit token cannot edit another content id", !(await ps.checkForContent(editor12, ContentPermission.Edit, "13")));
check("an edit token cannot delete", !(await ps.checkForContent(editor12, ContentPermission.Delete, "12")));
check("an edit token can upload temporary files", await ps.checkForTemporaryFile(editor12, TemporaryFilePermission.Create, undefined));
check("an edit token cannot install libraries", !(await ps.checkForGeneralAction(editor12, GeneralPermission.UpdateAndInstallLibraries)));
check("a delete token deletes its own content id", await ps.checkForContent(deleter12, ContentPermission.Delete, "12"));
check("a delete token cannot delete another id", !(await ps.checkForContent(deleter12, ContentPermission.Delete, "99")));
check("nobody creates content without an id (Conductor allocates first)", !(await ps.checkForContent(creator, ContentPermission.Create, undefined)));
check("a create token can upload temporary files", await ps.checkForTemporaryFile(creator, TemporaryFilePermission.Create, undefined));
check("a libraries token installs libraries", await ps.checkForGeneralAction(librarian, GeneralPermission.InstallRecommended));
check("a libraries token cannot edit content", !(await ps.checkForContent(librarian, ContentPermission.Edit, "12")));
check("nobody lists content", !(await ps.checkForContent(editor12, ContentPermission.List, undefined)));

// ------------------------------------------------------------ middleware
const app = express();
app.use(capabilityUserMiddleware(verify));
app.get("/probe", (req, res) => res.json({ id: req.user.id, cid: req.user.capability?.contentId ?? null }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const probe = async (headers) => {
  const res = await fetch(`${base}/probe`, { headers });
  return { status: res.status, body: await res.json(), auth: res.headers.get("www-authenticate") };
};

let r = await probe({});
check("no header runs as anonymous", r.status === 200 && r.body.id === "anonymous");
r = await probe({ authorization: `Bearer ${await sign()}` });
check("a valid token runs as its subject", r.status === 200 && r.body.id === "11111111-1111-4111-8111-111111111111" && r.body.cid === "31483");
r = await probe({ authorization: `Bearer ${await sign({}, { iat: now - 1000, exp: now - 100 })}` });
check("an expired token is a 401, not anonymous", r.status === 401 && r.auth?.includes("invalid_token"));
check("the 401 does not say why", JSON.stringify(r.body) === JSON.stringify({ error: "invalid_token" }));
r = await probe({ authorization: "Basic dXNlcjpwYXNz" });
check("a non-Bearer header is a 401", r.status === 401);
r = await probe({ authorization: "Bearer " });
check("an empty Bearer is a 401", r.status === 401);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
// See verify-embed-contract.mjs: no process.exit() with a server open.
process.exitCode = failures === 0 ? 0 : 1;
server.close();
