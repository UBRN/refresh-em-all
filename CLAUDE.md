# Working in this repository

Chrome MV3 extension. Project structure, contributor setup, and the full
command list are in [CONTRIBUTING.md](CONTRIBUTING.md); test strategy and
per-suite coverage are in [TESTING.md](TESTING.md). This file carries only what
an agent gets wrong without being told.

## Acceptance criterion

`npm test` is the acceptance criterion for a change here: the full Jest unit,
integration, and contract suite, about one second. TESTING.md states the current
test and suite counts and is the only place that number lives, so update it
there when you add or remove a test and do not copy it anywhere else.

Do not use `npm run e2e` as the acceptance criterion inside a sandboxed agent
lane. Puppeteer has to listen on 127.0.0.1 and the sandbox denies it
(`listen EPERM: operation not permitted 127.0.0.1`). The same applies to any
step that needs `npm install`, since sandboxed lanes have no network. Real
browser verification and anything requiring installation run outside the
sandbox.

## Install

`npm ci --legacy-peer-deps`, Node 24 (`.nvmrc`). The peer-dependency flag is
required because `jest-chrome@0.8.0` declares Jest 26/27 support while this
repository uses Jest 29. Dropping the flag is a reviewed test-mock migration,
not a cleanup.

## Release invariants

`package.json`, `package-lock.json` (both the top-level version and the root
entry in `packages`), and `manifest.json` must carry the same version, which is
also the ZIP filename. `npm run package` throws on any mismatch, validates the
`_locales` catalogs, and verifies the archive it just wrote. Bump all of them
together or the package step fails.

## Writing

No em dash in code, comments, documentation, or commit messages. Use a comma, a
period plus a new sentence, a colon, or parentheses.
