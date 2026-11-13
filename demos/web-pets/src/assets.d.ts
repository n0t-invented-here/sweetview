// A model file imported by path: the import resolves to a URL the page can
// fetch, and the bundler ships the file. Bun, Vite and esbuild do this by
// default; webpack needs asset modules for .glb and .png.
declare module "*.glb" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
