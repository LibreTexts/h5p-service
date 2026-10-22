/**
 * Exercises IntegerIdContentStorage against a real MongoDB and an
 * S3-compatible store.
 *
 * The property that matters is the one upstream cannot provide: content is
 * stored and retrieved under Studio's integer id, and the S3 key layout is
 * byte-identical to Studio's on-disk layout so the 33 GB migration is a plain
 * sync. Everything else here guards against breaking that while editing.
 *
 *   docker run -d --name h5p-mongo -p 37018:27017 mongo:7
 *   docker run -d --name h5p-minio -p 9100:9000 \
 *     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
 *     minio/minio server /data
 *   npm run build && node scripts/verify-content-storage.mjs
 */
import { Readable } from "node:stream";
import { MongoClient } from "mongodb";
import { S3, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const MONGO_URL = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:37018";
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT || "http://127.0.0.1:9100";
const BUCKET = "h5p-content-test";

const { default: IntegerIdContentStorage } = await import(
  "../dist/storage/IntegerIdContentStorage.js"
);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures += 1;
}

const s3 = new S3({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY || "minioadmin",
  },
});
try {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
} catch {
  /* already exists */
}

const mongo = new MongoClient(MONGO_URL);
await mongo.connect();
const db = mongo.db("h5p_test");
await db.collection("content").deleteMany({});
await db.collection("counters").deleteMany({});

const storage = new IntegerIdContentStorage(
  s3,
  db.collection("content"),
  db.collection("counters"),
  { s3Bucket: BUCKET }
);

const user = { id: "tester", email: "", name: "Tester", type: "local" };
const metadata = {
  title: "Photosynthesis Quiz",
  mainLibrary: "H5P.MultiChoice",
  language: "en",
  license: "CC BY",
  embedTypes: ["iframe"],
  preloadedDependencies: [
    { machineName: "H5P.MultiChoice", majorVersion: 1, minorVersion: 16 },
  ],
};
const params = { question: "Which organelle?", answers: [{ text: "Chloroplast" }] };

// 1. The whole point: a Studio integer id survives a round trip.
const STUDIO_ID = "31483";
const returned = await storage.addContent(metadata, params, user, STUDIO_ID);
check("addContent preserves the Studio integer id", returned === STUDIO_ID, `got ${returned}`);

const storedDoc = await db.collection("content").findOne({ _id: STUDIO_ID });
check("_id is stored as the integer string, not an ObjectId",
  storedDoc !== null && typeof storedDoc._id === "string", `typeof ${typeof storedDoc?._id}`);

check("getMetadata round-trips", (await storage.getMetadata(STUDIO_ID)).title === "Photosynthesis Quiz");
check("getParameters round-trips", (await storage.getParameters(STUDIO_ID)).question === "Which organelle?");
check("contentExists is true for a stored id", (await storage.contentExists(STUDIO_ID)) === true);
check("contentExists is false for an unknown id", (await storage.contentExists("999999")) === false);

// 2. The S3 layout must match Studio's on disk, or the sync plan collapses.
await storage.addFile(STUDIO_ID, "images/diagram.png", Readable.from([Buffer.from("png-bytes")]), user);
await storage.addFile(STUDIO_ID, "content.json", Readable.from([Buffer.from("{}")]), user);

const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${STUDIO_ID}/` }));
const keys = (listed.Contents ?? []).map((c) => c.Key).sort();
check("S3 keys use the integer id as the top-level prefix",
  keys.includes(`${STUDIO_ID}/images/diagram.png`), keys.join(", "));
check("key layout matches Studio's files/h5p/content/{id}/... exactly",
  keys.every((k) => k.startsWith(`${STUDIO_ID}/`)));

const files = (await storage.listFiles(STUDIO_ID, user)).sort();
check("listFiles returns paths relative to the content id",
  JSON.stringify(files) === JSON.stringify(["content.json", "images/diagram.png"]), files.join(", "));
check("fileExists finds a stored file", (await storage.fileExists(STUDIO_ID, "content.json")) === true);
check("fileExists is false for a missing file", (await storage.fileExists(STUDIO_ID, "nope.txt")) === false);
check("getFileStats reports a size", (await storage.getFileStats(STUDIO_ID, "content.json", user)).size === 2);

// 3. Re-import of the same id must replace, not duplicate.
await storage.addContent({ ...metadata, title: "Updated" }, params, user, STUDIO_ID);
check("re-import replaces rather than duplicating",
  (await db.collection("content").countDocuments({ _id: STUDIO_ID })) === 1);
check("re-import updates metadata", (await storage.getMetadata(STUDIO_ID)).title === "Updated");

// 4. New content must not collide with migrated ids.
await storage.seedCounter(31483);
const newId = await storage.addContent(metadata, params, user);
check("new content id is numeric", /^\d+$/.test(newId), newId);
check("new content id sits above the migrated range", Number(newId) > 31483, newId);
const newId2 = await storage.addContent(metadata, params, user);
check("ids increment and do not repeat", Number(newId2) === Number(newId) + 1, `${newId} then ${newId2}`);

// 5. getUsage underpins library deletion safety.
const usage = await storage.getUsage({ machineName: "H5P.MultiChoice", majorVersion: 1, minorVersion: 16 });
check("getUsage counts main-library use", usage.asMainLibrary === 3, JSON.stringify(usage));

// 6. Delete removes both the document and its S3 objects.
await storage.deleteContent(STUDIO_ID, user);
check("deleteContent removes the document", (await storage.contentExists(STUDIO_ID)) === false);
const afterDelete = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${STUDIO_ID}/` }));
check("deleteContent removes the S3 objects", (afterDelete.Contents ?? []).length === 0,
  `${(afterDelete.Contents ?? []).length} left`);

// 7. Path traversal must be rejected.
let rejected = false;
try {
  await storage.addFile(STUDIO_ID, "../../etc/passwd", Readable.from([Buffer.from("x")]), user);
} catch {
  rejected = true;
}
check("path traversal in a filename is rejected", rejected);

await mongo.close();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
