# Contributing

## Setup

```bash
npm install                 # also fetches and checksums the H5P client libraries
cp .env.example .env        # fill in the required section
npm run dev
```

Node 22 or newer. `.nvmrc` pins the major the Docker image ships on.

Every variable in the required section of `.env.example` has no default. The
service exits at startup naming the first one that is missing or malformed.
That is deliberate: this repository is public, and a default would be inherited
silently by a fork.

## Verifying a change

```bash
npm run typecheck              # types only, covers the migration too
npm run verify:embed-contract  # the public contracts; needs no database
```

`npm run verify:content-storage` exercises `IntegerIdContentStorage` against a
real MongoDB and MinIO. It is not in CI. Run it before any change under
`src/storage/`.

CI runs typecheck, build and the embed contract check on every pull request.

## Commits

Releases are automated. [Conventional Commits](https://www.conventionalcommits.org)
decide the next version, so the message format is load-bearing.

| Type | Releases | Use for |
| --- | --- | --- |
| `fix` | patch | A bug fix |
| `feat` | minor | New behaviour |
| `perf` | patch | A performance change |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style` | nothing | Everything else |

**Merges are squashed, and the pull request title becomes the commit subject.**
That title is what semantic-release reads. A title that is not a Conventional
Commit produces no release and no error, which is a silent failure rather than
a loud one. Check the title before merging.

### Do not use `!` or `BREAKING CHANGE:` before 1.0

This project is on 0.x. From `0.1.0`, semantic-release maps `feat` to `0.2.0`
and `fix` to `0.1.1`, which is what we want. But a `!` suffix or a
`BREAKING CHANGE:` footer increments the major to `1.0.0` -- semantic-release
has no 0.x suppression -- and a published version cannot be withdrawn.

Describe the break in the commit body instead and let it release as a `feat`.
Cutting 1.0.0 is a deliberate decision, not a side effect of a commit message.

## Things that are pinned on purpose

**The H5P stack.** `@lumieducation/h5p-server` 10.x targets H5P core API 1.27,
and `scripts/fetch-h5p-core.mjs` pins the client libraries to 1.27.0 and 1.25
to match. Together they are what lets Studio's existing content types load
unchanged. Dependabot is configured to ignore major bumps of
`@lumieducation/*`, and the dependency versions are exact rather than
caret-ranged for the same reason. Read the "H5P version pinning" section of
README.md before changing any of them, and re-test against real activities.

**The client library checksums.** The two tarballs are verified against
recorded SHA-256 digests. A mismatch means the upstream tag moved or the
download was tampered with. Verify which before touching `DIGESTS` -- never
update a digest to make a failing fetch pass.

**GitHub Action versions.** Every action is pinned to a full commit SHA with
its version in a trailing comment. Dependabot maintains both. To add one:

```bash
gh api repos/<owner>/<repo>/releases/latest --jq .tag_name
gh api repos/<owner>/<repo>/commits/<tag>   --jq .sha
```

Use the `commits` endpoint. `git/refs/tags/<tag>` returns the tag object's SHA
for an annotated tag, which does not work as an Actions pin.

## Public contracts

Four things are depended on by software outside LibreTexts' control: the embed
URL shape, the Drupal-shaped resizer path, the `public/embed.js` message
protocol, and integer content ids. Changing any of them breaks published
textbooks or student grading. They are documented in README.md and owned via
CODEOWNERS. If a change touches one, say so in the pull request.

## Configuration

Anything deployment-specific goes through `src/config.ts`, is validated by
`src/config/env.ts`, and is documented in `.env.example`. Do not read
`process.env` elsewhere.

`public/embed.js` is served statically and never compiled, so it cannot read
the environment. Values it needs arrive through the `__LIBRETEXTS_EMBED__`
object built in `src/embed/renderer.ts`. Adding a field there is the only way
to make something in that file configurable.
