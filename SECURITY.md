# Security

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/LibreTexts/h5p-service/security/advisories/new).
Do not open a public issue.

Expect an acknowledgement within five working days. If a fix is needed we will
agree a disclosure timeline with you before publishing.

## Supported versions

Only the latest release is supported. There are no maintenance branches: fixes
ship in the next release from `main`.

## Intentional behaviours

Three things in this codebase look like vulnerabilities and are deliberate.
They are documented here so reports can focus on real problems.

**The embed accepts DOM-mutation messages from allowlisted origins.** The embed
page accepts `{elements}` and `{templates}` postMessage instructions that
rewrite its own DOM, because ADAPT restyles activities through them. Studio
accepted these from *any* origin with no validation. This service checks the
sender against `ALLOWED_EMBED_PARENT_ORIGINS`. An origin on that allowlist can
rewrite the embed's contents by design, so treat the allowlist as a trust
boundary and keep it short.

**Outbound postMessage targets `*`.** `public/embed.js` posts its load
handshake and relays xAPI statements to `*`. ADAPT grades against the xAPI
relay and narrowing the target would break student grading. The messages carry
no secrets.

**The embed route skips permission checks.** `src/routes/embed.ts` renders with
`ignoreUserPermissions: true`. Access control for an activity lives in
Conductor, which owns the activity record and decides who may reach the embed
URL. This service deliberately serves H5P primitives and nothing else.

## In scope

Reports about anything else are welcome, and these especially:

- Bypassing the `ALLOWED_EMBED_PARENT_ORIGINS` check in `public/embed.js`.
- Escaping the `frame-ancestors` policy, or injecting into any response header.
- Injection through the embed page's inlined JSON (`H5PIntegration` or
  `__LIBRETEXTS_EMBED__`).
- Path traversal in content or library file keys reaching S3.
- Anything that lets one content id read or overwrite another's files.
