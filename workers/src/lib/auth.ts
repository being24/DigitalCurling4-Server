/**
 * `src/authentication/basic_authentication.py::check_user_data`の移植。
 * ハッシュ方式: sha256(password + salt + pepper).hexdigest() (Python版と同一)
 */
export async function hashPassword(
  password: string,
  salt: string,
  pepper: string,
): Promise<string> {
  const data = new TextEncoder().encode(password + salt + pepper);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `secrets.compare_digest`相当の定数時間文字列比較。
 * SHA256の16進文字列(常に64文字)を比較する用途を想定。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
