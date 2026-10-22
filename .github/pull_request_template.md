## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] **The PR title is a Conventional Commit.** Merges are squashed and the
      title becomes the commit subject, which is what semantic-release parses
      to decide the next version. A non-conventional title silently produces no
      release. Examples: `fix: reject malformed content ids`,
      `feat: serve the editor ajax routes`, `docs: document the env table`.
- [ ] `npm run typecheck` and `npm run verify:embed-contract` pass locally.
- [ ] No change to the public contracts in README.md ("Public contracts"), or
      the change is called out below and in the commit body.
- [ ] No new hardcoded deployment values. Anything environment-specific goes
      through `src/config.ts` and is documented in `.env.example`.
- [ ] If a new required environment variable was added, the deploy
      configuration is updated before this ships. The service fails to start
      without it.

<!-- Pre-1.0: do NOT use `!` or a BREAKING CHANGE footer. From 0.x that
     publishes 1.0.0, which cannot be undone. Describe the break in the body
     and let it release as a feat. See CONTRIBUTING.md. -->
