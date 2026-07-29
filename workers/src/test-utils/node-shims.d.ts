/**
 * `@types/node`を追加依存にせず(Cloudflare Workers用の`@cloudflare/workers-types`とのグローバル型衝突を避けるため)、
 * テストコード(vitest, プレーンNode環境で実行)でのみ使うNode組込みモジュール/グローバルの最小アンビエント宣言。
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  }
}

declare const __dirname: string;

declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
};
