/**
 * Vite's `?inline` query hands a file back as a data URI string. The client
 * tsconfig has `types: []`, so this is the one declaration that names it.
 */
declare module '*.glb?inline' {
  const dataUri: string;
  export default dataUri;
}
