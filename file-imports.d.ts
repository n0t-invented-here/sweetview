// Types for the page files an app imports by path:
//
//   import js from "./build/frontend/main.js" with { type: "file" };
//
// The import resolves to a path the file can be read from (`Bun.file(js)` is
// the asset), and `bun build --compile` embeds the file. Pull these in from
// a .d.ts of the app's own:
//
//   /// <reference types="@n1h/sweetview/file-imports" />
//
// and declare the app's other file kinds (models, images) beside it.
declare module "*.css" {
  const path: string;
  export default path;
}
declare module "*.js" {
  const path: string;
  export default path;
}
