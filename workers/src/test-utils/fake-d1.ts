import { DatabaseSync } from "node:sqlite";

/**
 * drizzle-orm/d1が要求するD1Database最小互換シム。
 *
 * `node:sqlite`(Node組込み、experimental)をバックエンドに使い、実際のSQL実行を通して
 * リポジトリ層のテストを行う。D1固有の挙動(レプリケーション、batch内アトミック性)は
 * 再現しないが、SQL文の正しさ・drizzleの結果マッピングの検証には十分。
 * vitest(プレーンなVite環境)は`.wasm`直接importをロードできないため、
 * `@cloudflare/vitest-pool-workers`を導入しない限り実D1でのテストはできない
 * (Task07の05_log.mdで導入見送りが既に検討済み)。このシムはその代替。
 */

interface BoundStatement {
  run(): { results: unknown[] };
  all(): { results: unknown[] };
  raw(): unknown[][];
}

export function createFakeD1Database(schemaSql: string) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schemaSql);

  function bindStatement(sql: string, params: unknown[]): BoundStatement {
    const stmt = sqlite.prepare(sql);
    return {
      run: () => {
        stmt.run(...(params as never[]));
        return { results: [] };
      },
      all: () => {
        const rows = stmt.all(...(params as never[])) as Record<
          string,
          unknown
        >[];
        return { results: rows };
      },
      raw: () => {
        // JOINで複数テーブルに同名カラム(score_id, tournament_id等)が存在する場合、
        // オブジェクト形式(all())だとキーがマージされ列が失われる。Drizzleの
        // D1PreparedQuery.values()は位置ベースの配列を要求するため、setReturnArrays(true)で
        // SELECT句の順序通りの配列として取得する(呼び出し後は元の状態に戻す)。
        stmt.setReturnArrays(true);
        try {
          return stmt.all(...(params as never[])) as unknown as unknown[][];
        } finally {
          stmt.setReturnArrays(false);
        }
      },
    };
  }

  return {
    prepare(sql: string) {
      return {
        bind: (...params: unknown[]) => bindStatement(sql, params),
      };
    },
    async batch(
      boundStatements: BoundStatement[],
    ): Promise<{ results: unknown[] }[]> {
      return boundStatements.map((bound) => bound.all());
    },
    // vitest上ではDrizzleD1Databaseの型と構造的に一致すれば十分なため、
    // 未実装のD1Database APIは呼ばれない前提でここまでに留める。
  };
}
