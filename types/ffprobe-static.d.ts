// Ambient module declaration for `ffprobe-static`.
//
// ffprobe-static npm 包自身不提供 .d.ts 也无 DefinitelyTyped 配套 (@types 没发).
// 它运行时导出 `{ path: string }` — 当前 platform 平台的 bundled ffprobe 二进制绝对路径.
// 之前 worker/phases/(qg-checks.ts|tests/*) 用 `import { path as ffprobeBinPath }` 时
// tsc 报 TS7016 'Could not find a declaration file for module ffprobe-static'.
//
// 本文件即 ambient declaration — 跟 `lib/pipeline/qg-checks.ts` 隔空握手.
// tsconfig.json 'include' 是 '**/*.ts', 任何位置 *.d.ts 文件自动加载.

declare module 'ffprobe-static' {
  /** 当前 platform 的 bundled ffprobe binary 绝对路径 (linux/darwin/win32 + arch)。 */
  export const path: string;
}
