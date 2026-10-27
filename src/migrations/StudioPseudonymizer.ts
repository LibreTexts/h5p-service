/**
 * Deterministic pseudonymisation for non-production Studio imports.
 *
 * Adapted from Conductor's `StudioPseudonymizer` (MIT, Copyright (c) 2023
 * LibreTexts). Conductor's version also derives user uuids; Studio's H5P
 * tables carry no user identifiers, so only the name and free-text handling
 * came across.
 *
 * The goal is dev data that behaves like production without containing anyone's
 * identity. Pseudonyms are derived with a keyed HMAC, so the same real author
 * always maps to the same fake author: an author credited on 400 activities is
 * still credited on 400 in dev, and a re-run writes byte-identical records,
 * which keeps the import idempotent. With 625 name pairs, two real authors can
 * share a pseudonym. That merges them in dev and never splits one.
 *
 * A keyed HMAC rather than a plain hash, because author names are a guessable
 * input space. Anyone with a list of LibreTexts authors could reverse a bare
 * SHA-256 by trying each name. Without the key they cannot.
 *
 * ## The salt
 *
 * The salt is a secret and is read from `STUDIO_PSEUDONYM_SALT`. Supply it by
 * running the importer under `asm-exec` with a resolve token, so the value is
 * injected at runtime and never pasted into a shell, a file, or a log:
 *
 *   STUDIO_PSEUDONYM_SALT='{{resolve:secretsmanager:studio/migration:SecretString:pseudonymSalt}}' \
 *     asm-exec npm run migrate:studio-content
 *
 * Never commit it, never echo it, and never copy it into a dev environment:
 * the salt sitting next to the pseudonymised data would defeat the point. If a
 * dev environment is ever exposed, rotate the salt and re-import.
 */
import crypto from "node:crypto";

/**
 * Reserved by RFC 2606 and guaranteed never to resolve, so generated addresses
 * are undeliverable by construction rather than by convention. A typo'd real
 * domain could receive mail; `.invalid` cannot.
 */
const REDACTED_EMAIL = "redacted@dev.invalid";

const FIRST_NAMES = [
  "Avery", "Blair", "Casey", "Darcy", "Ellis", "Finley", "Harper", "Indigo",
  "Jordan", "Kai", "Lennox", "Marlow", "Noor", "Oakley", "Paz", "Quinn",
  "Reese", "Sage", "Tatum", "Umber", "Vale", "Wren", "Xan", "Yuri", "Zephyr",
];

const LAST_NAMES = [
  "Alder", "Brooks", "Calder", "Dunne", "Ellery", "Fairbank", "Glass",
  "Hollis", "Ingram", "Jessop", "Kestrel", "Lowry", "Mercer", "Northcote",
  "Orford", "Pike", "Quill", "Rowan", "Sorrel", "Thorne", "Upton", "Vance",
  "Whitlock", "Yardley", "Zinn",
];

/** Matches most real-world addresses well enough to redact them from prose. */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const MIN_SALT_LENGTH = 16;

export default class StudioPseudonymizer {
  private readonly key: Buffer;

  constructor(salt: string) {
    if (!salt || salt.length < MIN_SALT_LENGTH) {
      throw new Error(
        `STUDIO_PSEUDONYM_SALT must be at least ${MIN_SALT_LENGTH} characters.`
      );
    }
    this.key = Buffer.from(salt, "utf-8");
  }

  /** Keyed digest of one input, scoped so different fields never collide. */
  private digest(scope: string, value: string): Buffer {
    return crypto
      .createHmac("sha256", this.key)
      .update(`${scope}:${value}`)
      .digest();
  }

  /**
   * Stable fake name for a real one.
   *
   * Keyed on the normalised name, so "Jane  Doe" and "jane doe" typed on two
   * different activities still resolve to one pseudonym.
   */
  name(realName: string): string {
    const normalised = realName.trim().replace(/\s+/g, " ").toLowerCase();
    const h = this.digest("name", normalised);
    const first = FIRST_NAMES[h.readUInt16BE(0) % FIRST_NAMES.length];
    const last = LAST_NAMES[h.readUInt16BE(2) % LAST_NAMES.length];
    return `${first} ${last}`;
  }

  /**
   * Redacts addresses from free text.
   *
   * Names in prose cannot be found reliably, so this reduces exposure rather
   * than eliminating it. Dev keeps production-grade access control for that
   * reason.
   */
  scrubText(text: string): string {
    return text.replace(EMAIL_IN_TEXT, REDACTED_EMAIL);
  }

  /**
   * Replaces each name in the H5P metadata author list, `[{name, role}]`.
   *
   * Structure and roles are preserved so the "Rights of use" dialog renders
   * the same shape it does in production.
   */
  authors(authors: unknown[]): unknown[] {
    return authors.map((entry: any) => ({
      ...entry,
      ...(typeof entry?.name === "string" ? { name: this.name(entry.name) } : {}),
    }));
  }

  /** H5P metadata change log, `[{date, author, log}]`. */
  changes(changes: unknown[]): unknown[] {
    return changes.map((entry: any) => ({
      ...entry,
      ...(typeof entry?.author === "string"
        ? { author: this.name(entry.author) }
        : {}),
      ...(typeof entry?.log === "string" ? { log: this.scrubText(entry.log) } : {}),
    }));
  }

  /**
   * Walks content parameters, the activity itself.
   *
   * Two carriers are handled. Media `copyright.author` fields hold real names
   * in a known place, so they get pseudonyms. Every other string has email
   * addresses redacted, because instructors put contact details in activity
   * text.
   *
   * `path` values are left alone. They name files synced byte-for-byte from
   * Studio, and a retina asset such as `images/logo@2x.png` matches the email
   * pattern. Rewriting it would break the image rather than protect anyone.
   */
  parameters(value: unknown, key?: string, parentKey?: string): unknown {
    if (typeof value === "string") {
      if (key === "path") return value;
      if (key === "author" && parentKey === "copyright") return this.name(value);
      return this.scrubText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.parameters(item, undefined, key));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.parameters(v, k, key)])
      );
    }
    return value;
  }
}
