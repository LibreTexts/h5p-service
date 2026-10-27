/**
 * Exercises the authoring routes against a real MongoDB and an S3-compatible
 * store, with authoring switched on: the editor page, the editor's AJAX gate,
 * temporary uploads, save, allocate and delete, all with capability tokens
 * signed here in place of Conductor.
 *
 * A manual gate like verify-content-storage, because it needs local services:
 *
 *   docker run -d --name h5p-mongo -p 47017:27017 mongo:7
 *   docker run -d --name h5p-minio -p 9100:9000 \
 *     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
 *     minio/minio server /data
 *   npm run verify:authoring
 *
 * It needs no internet access: the test content type is installed from a
 * temporary directory, not from the H5P hub. Everything it creates lives in a
 * throwaway database and throwaway buckets, removed at the end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { MongoClient } from "mongodb";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const MONGO_URL = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:47017";
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT || "http://127.0.0.1:9100";
const S3_KEY = process.env.TEST_S3_ACCESS_KEY_ID || "minioadmin";
const S3_SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY || "minioadmin";
const RUN = `verify-authoring-${Date.now()}`;
const CONDUCTOR = "https://conductor.example.test";

const keys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "verify-1" };

// The service reads configuration once, at import, so set it all first.
Object.assign(process.env, {
  MONGODB_URL: MONGO_URL,
  MONGODB_DB: RUN,
  S3_CONTENT_BUCKET: `${RUN}-content`,
  S3_LIBRARY_BUCKET: `${RUN}-libraries`,
  S3_TEMPORARY_BUCKET: `${RUN}-temp`,
  AWS_S3_ENDPOINT: S3_ENDPOINT,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: S3_KEY,
  AWS_SECRET_ACCESS_KEY: S3_SECRET,
  BASE_URL: "https://verify.example.test",
  ALLOWED_EMBED_PARENT_ORIGINS: "https://parent.example.test",
  EMBED_FRAME_ANCESTORS: "https://*.example.test",
  EMBED_ADAPT_REFERRERS: "https://adapt.example.test",
  EMBED_TRUSTED_PARENT_HOSTS: "trusted.example.test",
  AUTHORING_ENABLED: "true",
  CAPABILITY_TOKEN_PUBLIC_KEYS: JSON.stringify({ keys: [jwk] }),
  EDITOR_PARENT_ORIGINS: CONDUCTOR,
  LOG_LEVEL: process.env.LOG_LEVEL || "silent",
});

const s3 = new S3({ endpoint: S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } });
for (const b of ["content", "libraries", "temp"]) await s3.send(new CreateBucketCommand({ Bucket: `${RUN}-${b}` }));

const { buildH5P } = await import("../dist/h5p.js");
const { createApp } = await import("../dist/app.js");
const stack = await buildH5P();

// A minimal content type, installed the way an admin's install would.
const libDir = fs.mkdtempSync(path.join(os.tmpdir(), "h5p-verify-lib-"));
fs.writeFileSync(path.join(libDir, "library.json"), JSON.stringify({
  title: "Verify Text", machineName: "H5P.VerifyText", majorVersion: 1, minorVersion: 0, patchVersion: 0,
  runnable: 1, embedTypes: ["iframe"], preloadedJs: [{ path: "text.js" }],
}));
fs.writeFileSync(path.join(libDir, "semantics.json"), JSON.stringify([
  { name: "text", type: "text", label: "Text" },
  { name: "image", type: "image", label: "Image", optional: true },
]));
fs.writeFileSync(path.join(libDir, "text.js"), "H5P.VerifyText = function () {};");
await stack.editor.libraryManager.installFromDirectory(libDir, false);
fs.rmSync(libDir, { recursive: true, force: true });

const server = createApp(stack).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
}

const now = () => Math.floor(Date.now() / 1000);
function token(act, cid, sub = "11111111-1111-4111-8111-111111111111") {
  const claims = { act, jti: crypto.randomUUID(), ...(cid !== undefined ? { cid: String(cid) } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
    .setIssuer("conductor").setAudience("h5p-service").setSubject(sub)
    .setIssuedAt(now()).setExpirationTime(now() + 900)
    .sign(keys.privateKey);
}
const auth = async (act, cid) => ({ authorization: `Bearer ${await token(act, cid)}` });
const service = async (act, cid) => ({ authorization: `Bearer ${await token(act, cid, "conductor-service")}` });
async function call(method, url, { headers = {}, json, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) init.body = body;
  const res = await fetch(base + url, init);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, headers: res.headers, body: parsed };
}
function integrationOf(html, contentId) {
  const marker = "window.H5PIntegration = ";
  const start = html.indexOf(marker) + marker.length;
  return JSON.parse(html.slice(start, html.indexOf(";</script>", start)));
}

// ---------------------------------------------------------- editor page
let r = await call("GET", "/h5p/new/edit");
check("new-activity editor page is served without a token", r.status === 200);
check("only Conductor may frame the editor", r.headers.get("content-security-policy") === `frame-ancestors ${CONDUCTOR}`, r.headers.get("content-security-policy"));
check("the editor page is never cached", r.headers.get("cache-control") === "no-store");
const pageIntegration = integrationOf(r.body);
check("the token wrapper is the inner iframe's first script", pageIntegration.editor.assets.js[0] === "/h5p/editor-auth.js");
check("the token wrapper also loads in the page itself", r.body.includes('<script src="/h5p/editor-auth.js"></script>'));
check("the page knows Conductor's origin for messages", r.body.includes(`"parentOrigins":["${CONDUCTOR}"]`));
r = await call("GET", "/h5p/99999/edit");
check("the editor page for unknown content is a 404", r.status === 404);
r = await call("GET", "/h5p/editor-page.js");
check("the editor protocol script is served", r.status === 200 && String(r.body).includes('type: "ready"'));

// ---------------------------------------------------------- allocate
r = await call("POST", "/h5p/service/allocate");
check("allocate without a token is a 401", r.status === 401);
r = await call("POST", "/h5p/service/allocate", { headers: await auth(["edit"], 5) });
check("allocate with an edit token is a 403", r.status === 403);
r = await call("POST", "/h5p/service/allocate", { headers: await service(["allocate"]) });
const contentId = r.body.contentId;
check("allocate returns a new numeric id", r.status === 201 && /^\d+$/.test(contentId), JSON.stringify(r.body));
const second = (await call("POST", "/h5p/service/allocate", { headers: await service(["allocate"]) })).body.contentId;
check("ids are never handed out twice", Number(second) === Number(contentId) + 1, `${contentId} then ${second}`);

// ---------------------------------------------------------- editor AJAX gate
r = await call("GET", "/h5p/ajax?action=libraries");
check("the editor's AJAX endpoint refuses anonymous calls", r.status === 401);
const big = "x".repeat(3 * 1024 * 1024);
r = await call("POST", "/h5p/ajax?action=libraries", { body: big, headers: { "content-type": "application/json" } });
check("an anonymous large body is refused before it is parsed", r.status === 401, `got ${r.status}`);
r = await call("GET", "/h5p/ajax?action=libraries&machineName=H5P.VerifyText&majorVersion=1&minorVersion=0", { headers: await auth(["edit"], contentId) });
check("the editor can load an installed content type", r.status === 200 && JSON.stringify(r.body).includes("semantics"), `got ${r.status}`);

// ---------------------------------------------------------- temporary upload
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201" + "a5f3c5d70000000049454e44ae426082", "hex");
const form = () => {
  const f = new FormData();
  f.append("field", JSON.stringify({ name: "image", type: "image" }));
  f.append("contentId", String(contentId));
  f.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
  return f;
};
r = await call("POST", "/h5p/ajax?action=files", { body: form() });
check("an anonymous upload is refused", r.status === 401);
r = await call("POST", "/h5p/ajax?action=files", { body: form(), headers: await auth(["edit"], contentId) });
const tempPath = r.body?.path;
check("an author can upload a temporary file", r.status === 200 && typeof tempPath === "string", JSON.stringify(r.body).slice(0, 120));
r = await call("GET", `/h5p/temp-files/${String(tempPath).replace(/#tmp$/, "")}`);
check("the unsaved upload can be previewed without a token", r.status === 200, `got ${r.status}`);

// ---------------------------------------------------------- save
const saveBody = (text, extra = {}) => ({
  library: "H5P.VerifyText 1.0",
  params: {
    params: { text, image: { path: tempPath, mime: "image/png" } },
    metadata: { title: "Verify activity", license: "CC BY", licenseVersion: "4.0", defaultLanguage: "en" },
  },
  ...extra,
});
r = await call("POST", `/h5p/${contentId}/save`, { json: saveBody("hello") });
check("save without a token is a 401", r.status === 401);
r = await call("POST", `/h5p/${contentId}/save`, { json: saveBody("hello"), headers: await auth(["edit"], Number(contentId) + 50) });
check("save with a token for another activity is a 403", r.status === 403);
r = await call("POST", `/h5p/${contentId}/save`, { json: saveBody("hello"), headers: await auth(["create"]) });
check("save with a create token is a 403", r.status === 403);
r = await call("POST", `/h5p/${contentId}/save`, { json: saveBody("hello", { displayOptions: { frame: true } }), headers: await auth(["edit"], contentId) });
check("incomplete display options are a 400", r.status === 400);
r = await call("POST", `/h5p/${contentId}/save`, {
  json: saveBody(big, { displayOptions: { frame: true, download: false, embed: true, copyright: true } }),
  headers: await auth(["edit"], contentId),
});
check("a first save into an allocated id succeeds, above the 2 MB global limit", r.status === 200 && r.body.contentId === contentId, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
check("save returns the metadata Conductor needs", r.body.title === "Verify activity" && r.body.license === "CC BY" && r.body.library === "H5P.VerifyText 1.0");
check("save returns the stored display options", JSON.stringify(r.body.displayOptions) === JSON.stringify({ frame: true, download: false, embed: true, copyright: true }));

const files = await s3.send(new ListObjectsV2Command({ Bucket: `${RUN}-content`, Prefix: `${contentId}/` }));
check("the uploaded image moved into the activity's own folder", (files.Contents ?? []).some((o) => o.Key.startsWith(`${contentId}/images/`)), (files.Contents ?? []).map((o) => o.Key).join(", "));

r = await call("GET", `/h5p/${contentId}/embed`);
const embedOptions = integrationOf(r.body).contents[`cid-${contentId}`].displayOptions;
check("the embed shows the saved activity", r.status === 200);
check("the embed applies the author's display options", embedOptions.export === false && embedOptions.embed === true && embedOptions.copyright === true, JSON.stringify(embedOptions));

r = await call("POST", `/h5p/${contentId}/save`, { json: saveBody("edited"), headers: await auth(["edit"], contentId) });
check("a later save without display options keeps them", r.status === 200 && r.body.displayOptions.download === false);
r = await call("GET", `/h5p/${contentId}/edit`);
check("the editor page for saved content is served", r.status === 200);
check("the editor page carries the stored display options", r.body.includes('"displayOptions":{"frame":true,"download":false,"embed":true,"copyright":true}'));

const failedId = (await call("POST", "/h5p/service/allocate", { headers: await service(["allocate"]) })).body.contentId;
r = await call("POST", `/h5p/${failedId}/save`, {
  json: { ...saveBody("x"), library: "H5P.NotInstalled 1.0" },
  headers: await auth(["edit"], failedId),
});
check("a first save that fails is an error", r.status >= 400, `got ${r.status}`);
check("a failed first save leaves no placeholder behind", !(await stack.contentStorage.contentExists(failedId)));

// ---------------------------------------------------------- libraries
r = await call("POST", "/h5p/ajax?action=library-install&id=H5P.Accordion", { headers: await auth(["edit"], contentId) });
const installed = await stack.editor.libraryManager.listInstalledLibraries();
check("an author cannot install a library", r.status >= 400 && !installed["H5P.Accordion"], `got ${r.status}`);

// ---------------------------------------------------------- delete
r = await call("DELETE", `/h5p/service/content/${contentId}`, { headers: await service(["delete"], Number(contentId) + 1) });
check("delete with a token for another id is a 403", r.status === 403);
r = await call("DELETE", `/h5p/service/content/${contentId}`, { headers: await auth(["edit"], contentId) });
check("delete with an edit token is a 403", r.status === 403);
r = await call("DELETE", `/h5p/service/content/${contentId}`, { headers: await service(["delete"], contentId) });
check("delete with a delete token for that id succeeds", r.status === 204);
r = await call("GET", `/h5p/${contentId}/embed`);
check("the deleted activity no longer embeds", r.status === 404);
const after = await s3.send(new ListObjectsV2Command({ Bucket: `${RUN}-content`, Prefix: `${contentId}/` }));
check("its files are gone from S3", (after.Contents ?? []).length === 0);
r = await call("DELETE", `/h5p/service/content/${contentId}`, { headers: await service(["delete"], contentId) });
check("deleting it again is a 404", r.status === 404);

// ---------------------------------------------------------- cleanup
server.close();
const mongo = new MongoClient(MONGO_URL);
await mongo.connect();
await mongo.db(RUN).dropDatabase();
await mongo.close();
for (const b of ["content", "libraries", "temp"]) {
  const Bucket = `${RUN}-${b}`;
  for (;;) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket }));
    if (!list.Contents?.length) break;
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) } }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket }));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
// The H5P stack keeps its Mongo connection open; exit once output is flushed.
setTimeout(() => process.exit(process.exitCode), 200).unref();
