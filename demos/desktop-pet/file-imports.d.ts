// Files imported by path (`with { type: "file" }`): the import resolves to a
// path the file can be read from, and `bun build --compile` embeds the file.
// The page files (*.css, *.js) are declared by sweetview; the pet's models
// and textures here.
/// <reference types="@n1h/sweetview/file-imports" />
declare module "*.glb" {
  const path: string;
  export default path;
}
declare module "*.png" {
  const path: string;
  export default path;
}
