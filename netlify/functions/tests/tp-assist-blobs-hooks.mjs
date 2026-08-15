// Module-customization hook (node:module register()) that redirects the ONE
// specifier `@netlify/blobs` - installed only in the Netlify build, absent
// locally - to the in-memory stub beside this file. Everything else resolves
// normally. Registered per test process by tp-assist-handler.test.mjs; not a
// test file itself.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@netlify/blobs') {
    return {
      shortCircuit: true,
      url: new URL('./tp-assist-blobs-stub.mjs', import.meta.url).href,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
