# LibreTexts H5P Service

[![CI](https://github.com/LibreTexts/h5p-service/actions/workflows/ci.yml/badge.svg)](https://github.com/LibreTexts/h5p-service/actions/workflows/ci.yml)

Hosts and plays H5P interactive activities for LibreTexts. This is the
replacement for the H5P engine inside LibreTexts Studio, which ran on an
end-of-life Drupal 9.4 / PHP 7.4 stack.

The service owns H5P primitives only: libraries, content, content files, the
player and the embed page. Everything around an activity — its title, author,
collaborators, subjects, tags, collections and catalog listing — lives in
Conductor, which addresses activities here by their H5P content id.

## Why this is a separate repository

It is built on [`@lumieducation/h5p-server`](https://github.com/Lumieducation/H5P-Nodejs-library),
which is GPL-3.0-or-later. Conductor is MIT. Keeping the H5P engine in its own
codebase and talking to it over HTTP preserves both licenses, and it lets the
player be cached and scaled separately from the application.

## Public contracts

Three things here are depended on by software outside LibreTexts' control.
Changing any of them breaks published textbooks or student grading.

**1. Embed URL.** Activities are embedded across the LibreTexts libraries as:

```html
<iframe src="https://studio.libretexts.org/h5p/{id}/embed" width=":w" height=":h"
        frameborder="0" allowfullscreen="allowfullscreen"></iframe>
<script src="https://studio.libretexts.org/modules/custom/h5p/vendor/h5p/h5p-core/js/h5p-resizer.js"
        charset="UTF-8"></script>
```

The `{id}` is the integer Studio assigned. The Drupal-shaped resizer path is
served as a permanent redirect to `/h5p/core/js/h5p-resizer.js`.

**2. The embed messaging protocol** (`public/embed.js`). The embed posts
`loaded` to its parent on load, relays every xAPI statement, and accepts
`{elements}` and `{templates}` messages that let the parent restyle the
activity. ADAPT grades against the xAPI relay and restyles through the inbound
messages. Treat that file as an interface document.

**3. Content ids.** The migration carries Studio's `h5p_content.id` values
across unchanged via `addContent(..., contentId)`. ADAPT's question bank and
every published embed address activities by that integer.

One deliberate change from Studio: inbound style messages are now checked
against `ALLOWED_EMBED_PARENT_ORIGINS`. Studio accepted them from any origin,
which let any page framing an activity rewrite its DOM.

## H5P version pinning

| Component | Version | Source |
| --- | --- | --- |
| `@lumieducation/h5p-server` | 10.0.4 | targets H5P core API 1.27 |
| H5P core client library | 1.27.0 | `h5p/h5p-php-library` |
| H5P editor client library | 1.25 | `h5p/h5p-editor-php-library` |

These match what Studio ran (`h5p/h5p-core` 1.27.0, `h5p/h5p-editor` 1.25),
which is what lets existing content types load without modification. Do not bump
them without re-testing against real activities.

The client libraries are fetched rather than vendored, by
`scripts/fetch-h5p-core.mjs` on postinstall. They are the MIT browser runtime,
not the GPL server code.

## Getting started

```bash
npm install            # also fetches and checksums the H5P client libraries
cp .env.example .env   # fill in the required section
npm run dev
```

## Configuration

Every variable in the first table is required and has no default. The service
exits at startup naming the first one that is missing or malformed.

Deployment-specific values are required on purpose. This repository is public,
so a default would be inherited silently by a fork, and a production deploy
could come up on a value nobody chose.

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | Public origin this service answers on, as a bare origin. Operator diagnostics only: the embed document emits same-origin relative URLs, so a wrong value does not break embeds. |
| `MONGODB_URL` | MongoDB holding content parameters, metadata and library records. |
| `S3_CONTENT_BUCKET` | Bucket for content files. |
| `S3_LIBRARY_BUCKET` | Bucket for library files. |
| `S3_TEMPORARY_BUCKET` | Bucket for uploads. |
| `AWS_REGION` | Region for the three buckets. |
| `AWS_ACCESS_KEY_ID` | S3 credentials. `@lumieducation/h5p-mongos3` requires these explicitly and does not fall back to an instance role or the SDK credential chain. |
| `AWS_SECRET_ACCESS_KEY` | As above. |
| `ALLOWED_EMBED_PARENT_ORIGINS` | Comma-separated bare origins allowed to drive the embed's styling API. A trust boundary: an origin here can rewrite the embed's DOM. |
| `EMBED_FRAME_ANCESTORS` | Space-separated CSP source list for the embed route's `frame-ancestors`. Validated and rebuilt before it reaches the header. |
| `EMBED_ADAPT_REFERRERS` | Comma-separated bare origins where the embed hides its export, embed and H5P links because the host supplies its own controls. |
| `EMBED_TRUSTED_PARENT_HOSTS` | Comma-separated bare host names treated as first-party. Everyone else sees the attribution badge. Matched exactly or by dot-suffix. |

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5100` | Listen port. Matches the Dockerfile's `EXPOSE` and healthcheck. |
| `NODE_ENV` | `development` | One of `development`, `test`, `production`. |
| `LOG_LEVEL` | `info` in production, else `debug` | A pino level. |
| `MONGODB_DB` | `h5p` | Database name. |
| `MONGODB_CONTENT_COLLECTION` | `h5p_content` | Content records. |
| `MONGODB_LIBRARY_COLLECTION` | `h5p_libraries` | Library records. |
| `MONGODB_COUNTER_COLLECTION` | `h5p_counters` | Content-id sequence, kept apart so allocating an id never contends with a content write. |
| `AWS_S3_ENDPOINT` | unset | Set for S3-compatible storage such as MinIO. Unset, the region resolves the real endpoint. |
| `H5P_CORE_PATH` | `h5p/core` | On-disk H5P core client library. Coupled to the image layout. |
| `H5P_EDITOR_PATH` | `h5p/editor` | On-disk H5P editor client library. |
| `EMBED_BADGE_HREF` | unset | Attribution badge link. With no href the badge is not rendered, so a deployment that is not LibreTexts shows no LibreTexts branding. |
| `EMBED_BADGE_LOGO_URL` | unset | Badge logo. |
| `EMBED_BADGE_LABEL` | unset | Badge text and link title. |

`STUDIO_MYSQL_*` are read only by the migration, lazily, so the service never
demands them. See `.env.example`.

## Docker

The image is published to GitHub Container Registry by a manually triggered
workflow, never automatically on merge or release.

```bash
docker pull ghcr.io/libretexts/h5p-service:<version>

docker run --rm -p 5100:5100 --env-file .env ghcr.io/libretexts/h5p-service:<version>
```

It listens on `$PORT` (5100), answers `GET /health`, runs as uid 1000 (`node`),
and carries a `HEALTHCHECK` that polls `/health`. The H5P client libraries are
fetched and checksum-verified during the build, not at runtime. The migration
is excluded from the compiled output, so it cannot be run from the image.

To build locally:

```bash
docker build --build-arg VERSION=0.0.0-dev --build-arg REVISION=$(git rev-parse HEAD) -t h5p-service:local .
```

## Releasing

Releases are automated by semantic-release on every push to `main`. It reads
[Conventional Commits](https://www.conventionalcommits.org) to decide the next
version, then writes a git tag, a GitHub release and `CHANGELOG.md`. Nothing is
published to npm.

Because merges are squashed, the pull request title is the commit subject
semantic-release parses. A title that is not a Conventional Commit produces no
release and no error. See CONTRIBUTING.md, including why `BREAKING CHANGE:`
must not be used before 1.0.

Publishing an image is a separate, deliberate step: run the **Docker**
workflow, give it the tag to build, and tick `push_latest` only when that build
should become `:latest`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode with `.env` loaded |
| `npm run build` | Compile TypeScript to `dist/`, excluding the migration |
| `npm start` | Run the compiled service |
| `npm run typecheck` | Types only, no emit, including the migration |
| `npm run fetch:h5p-core` | Re-fetch and verify the H5P client libraries |
| `npm run verify:embed-contract` | Assert the public contracts above still hold |
| `npm run verify:content-storage` | Exercise content storage against a real MongoDB and MinIO |
| `npm run migrate:studio-content` | One-time import of Studio libraries and content |

`verify:embed-contract` needs no database and runs in CI on every pull request.
`verify:content-storage` needs local containers and is a manual gate; run it
before any change under `src/storage/`.

## Migrating from Studio

`npm run migrate:studio-content` imports libraries and content from a Studio
MySQL database, preserving content ids. It is a dry run unless given
`--commit`, and it is idempotent: records are upserted by their natural key, so
a re-run after a partial failure resumes rather than duplicating.

It needs the `STUDIO_MYSQL_*` variables and the content files synced into
`S3_CONTENT_BUCKET` first. See the header of
`src/migrations/importStudioContent.ts`. The migration is not part of the
Docker image; run it from a checkout.

## Status

Phase 1: serving and embedding activities migrated from Studio. Authoring
arrives in phase 2, which is why the editor AJAX routes are currently disabled
in `src/index.ts`.
