/**
 * Environment variable readers and validators.
 *
 * Separate from `../config.js` so the validators can be imported without
 * triggering that module's eager, top-level validation. The migration needs
 * these helpers but must not force the server to have migration credentials
 * set, and vice versa.
 *
 * Every helper throws on bad input rather than coercing. A service that boots
 * with a silently wrong port or an empty origin allowlist is worse than one
 * that refuses to boot.
 */

/** An empty value is treated as unset: `FOO=` is the same as omitting `FOO`. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseInteger(
  name: string,
  raw: string,
  min: number,
  max: number
): number {
  // `Number`, not `parseInt`: `parseInt("8080abc")` returns 8080 and
  // `parseInt("abc")` returns NaN, and `app.listen(NaN)` binds an arbitrary
  // port without erroring.
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}, got "${raw}"`
    );
  }
  return value;
}

export function optionalInt(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  return parseInteger(name, raw, min, max);
}

export function requiredInt(
  name: string,
  min: number,
  max: number
): number {
  return parseInteger(name, required(name), min, max);
}

export function optionalEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `${name} must be one of ${allowed.join(", ")}, got "${raw}"`
    );
  }
  return raw as T;
}

function splitList(name: string, raw: string, separator: RegExp): string[] {
  const items = raw
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    // `FOO=","` would otherwise yield an empty allowlist, silently disabling
    // the feature it gates instead of reporting a misconfiguration.
    throw new Error(`${name} must contain at least one entry, got "${raw}"`);
  }
  return items;
}

export function requiredList(name: string, separator = /,/): string[] {
  return splitList(name, required(name), separator);
}

/**
 * Normalizes a value to a bare origin.
 *
 * `public/embed.js` compares allowlist entries against `event.origin`, which
 * never carries a trailing slash or a path. A configured
 * `https://adapt.libretexts.org/` would never match, and the styling API would
 * stop working with no error anywhere. Rejecting anything that is not already
 * a bare origin makes that failure impossible to configure.
 */
export function toOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https, got "${raw}"`);
  }
  if (url.origin !== raw) {
    throw new Error(
      `${name} must be a bare origin with no path, query or trailing slash. ` +
        `Use "${url.origin}" instead of "${raw}"`
    );
  }
  return url.origin;
}

export function requiredOrigin(name: string): string {
  return toOrigin(name, required(name));
}

export function requiredOriginList(name: string): string[] {
  return requiredList(name).map((entry) => toOrigin(name, entry));
}

/**
 * A CSP source expression: `'self'`, `'none'`, `*`, or a scheme-host with an
 * optional leading `*.` wildcard and optional port.
 */
const CSP_SOURCE =
  /^(?:'self'|'none'|\*|https?:\/\/(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?)$/;

/**
 * Validates a space-separated CSP source list and returns it rebuilt from the
 * validated tokens.
 *
 * The return value is interpolated into a `Content-Security-Policy` response
 * header. Rebuilding from validated tokens rather than sanitizing the raw
 * string is what makes CR, LF, `;` and `"` structurally unable to reach the
 * header, however permissive the host pattern is.
 */
export function requiredCspSourceList(name: string): string {
  const tokens = splitList(name, required(name), /\s+/);
  for (const token of tokens) {
    if (!CSP_SOURCE.test(token)) {
      throw new Error(
        `${name} contains an invalid CSP source expression: "${token}". ` +
          `Expected 'self', 'none', * or a scheme-host such as https://*.example.org`
      );
    }
  }
  return tokens.join(" ");
}

/** Host names for suffix matching: no scheme, no port, no path. */
export function requiredHostList(name: string): string[] {
  return requiredList(name).map((host) => {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)) {
      throw new Error(
        `${name} entries must be bare host names, got "${host}"`
      );
    }
    return host.toLowerCase();
  });
}

export function requiredRegion(name: string): string {
  const raw = required(name);
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(raw)) {
    throw new Error(
      `${name} must be an AWS region such as us-west-2, got "${raw}"`
    );
  }
  return raw;
}

/**
 * Rejects a half-configured static S3 credential pair.
 *
 * Both variables are optional: with neither set, the AWS SDK resolves
 * credentials through its default provider chain (see `src/h5p.ts`). With only
 * one set, the chain's environment provider reports no credentials rather than
 * an error and the chain moves on to the next source, typically a task role or
 * instance profile. S3 calls then succeed under an identity nobody chose,
 * which is worse than refusing to start.
 */
export function assertPairedAwsCredentials(): void {
  const hasKeyId = Boolean(process.env.AWS_ACCESS_KEY_ID);
  const hasSecret = Boolean(process.env.AWS_SECRET_ACCESS_KEY);
  if (hasKeyId === hasSecret) return;

  const [set, missing] = hasKeyId
    ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
    : ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID"];

  throw new Error(
    `${set} is set but ${missing} is not. Set both to use static credentials, or neither to use the AWS SDK default credential chain.`
  );
}

export interface StudioMysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  database: string;
}

/**
 * Reads the Studio MySQL connection used by the one-time content migration.
 *
 * A function rather than a field on the main config object, and called from
 * inside the migration, so the service never demands migration credentials it
 * does not use.
 *
 * `STUDIO_MYSQL_PASSWORD` stays optional on purpose: a local Studio dump is
 * commonly restored into a passwordless MySQL.
 */
export function loadStudioMysqlConfig(): StudioMysqlConfig {
  return {
    host: required("STUDIO_MYSQL_HOST"),
    port: optionalInt("STUDIO_MYSQL_PORT", 3306, 1, 65535),
    user: required("STUDIO_MYSQL_USER"),
    password: process.env.STUDIO_MYSQL_PASSWORD,
    database: required("STUDIO_MYSQL_DATABASE"),
  };
}

/**
 * Reads the HMAC key the migration pseudonymises identities with.
 *
 * Required whenever the migration runs without `--with-identities`, which is
 * the default. Length is checked by `StudioPseudonymizer` itself so the rule
 * lives next to the code that depends on it.
 */
export function loadStudioPseudonymSalt(): string {
  return required("STUDIO_PSEUDONYM_SALT");
}

/** A public Ed25519 key in JWK form, as `CAPABILITY_TOKEN_PUBLIC_KEYS` holds. */
export type Ed25519PublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };

/**
 * Reads a JWK set of public Ed25519 keys: `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"...","kid":"..."}]}`.
 *
 * Every key needs a `kid`, because tokens name their signing key and rotation
 * keeps two keys configured at once. A key carrying `d`, the private part, is
 * refused outright: this service only verifies, and a private key in its
 * environment would let anyone who can read that environment mint edit
 * rights.
 */
export function requiredEd25519PublicKeySet(name: string): Ed25519PublicJwk[] {
  const raw = required(name);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON Web Key Set, got unparseable JSON`);
  }
  const keys = parsed?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`${name} must be a JSON Web Key Set with at least one key in "keys"`);
  }
  const kids = new Set<string>();
  return keys.map((key: any, i: number) => {
    if (key && "d" in key) {
      throw new Error(`${name} key ${i} contains a private key ("d"). Configure the public key only.`);
    }
    if (key?.kty !== "OKP" || key?.crv !== "Ed25519") {
      throw new Error(`${name} key ${i} must be an Ed25519 key (kty "OKP", crv "Ed25519")`);
    }
    if (typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x)) {
      throw new Error(`${name} key ${i} has no valid "x" (43 base64url characters)`);
    }
    if (typeof key.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(key.kid)) {
      throw new Error(`${name} key ${i} needs a "kid" of 1 to 64 letters, digits, ".", "_" or "-"`);
    }
    if (kids.has(key.kid)) {
      throw new Error(`${name} has two keys with kid "${key.kid}"`);
    }
    kids.add(key.kid);
    return { kty: "OKP", crv: "Ed25519", x: key.x, kid: key.kid };
  });
}
