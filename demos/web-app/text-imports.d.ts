// The prebuilt frontend bundle is imported by path (`with { type: "file" }`);
// `bun build --compile` embeds the file and the import resolves to where it
// can be read from. The declarations for *.css and *.js are sweetview's.
/// <reference types="@n1h/sweetview/file-imports" />
