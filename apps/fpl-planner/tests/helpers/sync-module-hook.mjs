// A module-resolution hook that swaps the real sync layer for a stub.
//
// js/ui/settings.js reaches the cloud through a dynamic
// `import('../../../../sync-system/storage-sync-robust.js')`, and that module
// imports Firebase from https:// URLs, so it cannot load under `node --test` at
// all. Redirecting the specifier is what makes the signed-in deletion path
// testable without a Firebase session: the real click handler runs, and the
// erase call it makes is recorded instead of hitting Firestore.
//
// The redirect deliberately checks that the specifier resolves to a file that
// actually exists BEFORE substituting the stub. An earlier version matched on
// `endsWith('sync-system/storage-sync-robust.js')` alone, which is true for any
// number of leading `../` - so settings.js shipped a three-level path that
// resolves to /apps/sync-system/ (404 on production) while every unit test
// passed, because the stub answered regardless of depth. Resolving first means
// a wrong depth fails here instead of only in the browser.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let stubUrl = null;

export async function initialize(data) {
  stubUrl = data.stubUrl;
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('sync-system/storage-sync-robust.js')) {
    // Relative specifiers only: an absolute/bare one has no parent to resolve
    // against and is not what settings.js uses.
    if (specifier.startsWith('.') && context.parentURL) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      if (!existsSync(target)) {
        throw new Error(
          `sync-module-hook: "${specifier}" imported from ${context.parentURL} resolves to ` +
          `${target}, which does not exist. The canonical sync layer is ` +
          'sync-system/storage-sync-robust.js at the REPO ROOT; count the "../" segments ' +
          'from the importing file to there. Refusing to substitute the stub for a path ' +
          'that would 404 in a browser.'
        );
      }
    }
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
