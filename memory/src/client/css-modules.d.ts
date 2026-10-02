/** Browser bundler-owned CSS module exports. */
declare module '*.module.css' { const classes: Readonly<Record<string, string>>; export default classes; export const cssText: string }
