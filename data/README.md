# Seed dictionary provenance

Source: `fwwdn/sensitive-stop-words`, Apache-2.0. The immutable revision and SHA-256 hashes of source files are recorded in `upstream.json`. The complete license is preserved in `LICENSE-sensitive-stop-words.txt`. The upstream revision has no NOTICE file.

Upstream repository: `https://github.com/fwwdn/sensitive-stop-words`.

Modified for Azurekiln Moderation: imported four category files, split comma-separated and line-separated entries, trimmed whitespace, removed exact duplicates, and assigned category codes. Additional service-authored phrases cover the remaining moderation categories. No upstream stopword list or domain blacklist is imported. These changes are made by `scripts/import-words.mjs`.

Run `npm run data:import` to reproduce the bundled JSON. Runtime startup uses only local files and makes no upstream request. First provisioning seeds each app independently. Existing app dictionaries are never overwritten on restart, so administrator edits and deletions persist. Review the seed dictionary for false positives before production use. Administrators can add, edit, disable, or delete entries through the authenticated APIs.

The bundled custom test phrase `AZUREKILN_MODERATION_TEST_BLOCK` provides a stable smoke-test input. It is deliberately blocked without requiring offensive text in integration examples.
