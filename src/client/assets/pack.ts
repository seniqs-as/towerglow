/**
 * The model pack, as data.
 *
 * This is the only module that imports the `.glb` files, and it is loaded
 * with a dynamic `import()` so Rollup emits it as its own hashed chunk: about
 * six and a half megabytes of base64 that the server caches as immutable,
 * downloaded once per build and never on the critical path of the first
 * frame.
 *
 * Why data and not a URL: every three.js loader reaches for `fetch()`, and
 * the bundle must not contain one (`scripts/check-bundle.mjs`). A string
 * import needs no network primitive at all; `bytesFromDataUri` turns it into
 * bytes and `parseGlb` does the rest.
 */
import spacebase from './spacebase.glb?inline';
import crew from './crew.glb?inline';
import forest from './forest.glb?inline';
import villager from './villager.glb?inline';

export const PACK = { spacebase, crew, forest, villager } as const;
