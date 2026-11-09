// Files imported by path (`with { type: "file" }`): the import resolves to a
// path the file can be read from, and `bun build --compile` embeds the file.
// The page files (*.css, *.js) are declared by sweetview; the pet's models
// and textures here.
/// <reference path="../../file-imports.d.ts" />
declare module "*.glb" {
  const path: string;
  export default path;
}
declare module "*.png" {
  const path: string;
  export default path;
}
