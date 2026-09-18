// Standalone ambient declarations so this module typechecks outside the real repo.
// In quant-forge-os these come from vite/client — delete this file when dropping in.
interface ImportMetaEnv { readonly [key: string]: string | undefined }
interface ImportMeta { readonly env: ImportMetaEnv }
