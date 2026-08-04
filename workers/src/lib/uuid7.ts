import { v7 as uuidV7 } from "uuid";

/**
 * RFC 9562準拠のUUIDv7を生成する。
 * Python版(`uuid6`パッケージの`uuid7()`)の代替。時系列ソート可能なUUIDを返す。
 */
export function generateUuid7(): string {
  return uuidV7();
}
