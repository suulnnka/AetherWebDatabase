/* ============================================================
 * 加密 —— AES-256-GCM + PBKDF2(与 webos crypto.js 同构,独立零依赖)
 *
 * 落盘格式(整库一次加密):
 *   AWDB1:<base64(salt)>:<base64(iv)>:<base64(ciphertext)>
 *   - salt 16B / iv 12B 每次写盘随机
 *   - 密钥: PBKDF2-SHA-256 × 150000 → AES-GCM 256
 * 明文库直接存 JSON(以 '{' 开头),两种格式靠前缀区分。
 * ============================================================ */

const MAGIC = 'AWDB1';
const ITER = 150000;
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 是否为加密落盘内容 */
export function isEncrypted(raw) {
  return typeof raw === 'string' && raw.startsWith(MAGIC + ':');
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密明文 → AWDB1 串 */
export async function encryptText(plain, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain));
  return `${MAGIC}:${b64(salt)}:${b64(iv)}:${b64(cipher)}`;
}

/** 解密 AWDB1;密码错误/损坏时抛错 */
export async function decryptText(raw, password) {
  const parts = String(raw).split(':');
  if (parts[0] !== MAGIC || parts.length !== 4) throw new Error('不是有效的加密数据库');
  const [, saltB, ivB, dataB] = parts;
  const key = await deriveKey(password, unb64(saltB));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(dataB));
  } catch {
    throw new Error('密码错误或数据库已损坏');
  }
  return td.decode(plain);
}

export const cryptoDb = { isEncrypted, encryptText, decryptText, MAGIC };
export default cryptoDb;
