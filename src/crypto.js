/* ============================================================
 * 页级加密 —— AES-256-GCM;PBKDF2 只在 open/setPassword 做一次并缓存
 *
 * 数据页落盘(加密模式):
 *   [IV 12B][AES-GCM(pad(logical, chunkEnc)) = cipher||tag][恰好 PAGE_SIZE]
 *   chunkEnc = PAGE_SIZE - 12 - 16 = 4068
 *   逻辑载荷先零填充到 chunkEnc 再加密 → 密文长度固定,无需在页头记长度。
 *
 * 超级块始终明文(要读 salt / 目录定位)。
 * ============================================================ */

import { PAGE_SIZE, CHUNK_ENC } from './page.js';

const ITER = 150000;
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** PBKDF2-SHA-256 × 150000 → AES-GCM-256;调用方缓存 CryptoKey */
export async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * 逻辑载荷 → 固定 PAGE_SIZE 密文页。
 * @param {Uint8Array} logical ≤ chunkEnc 字节
 * @param {CryptoKey} key
 * @param {number} [chunkEnc]
 */
export async function encryptPage(logical, key, chunkEnc = CHUNK_ENC) {
  if (logical.length > chunkEnc) throw new Error('逻辑页超出 chunkSize');
  const plain = new Uint8Array(chunkEnc);
  plain.set(logical);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const page = new Uint8Array(PAGE_SIZE);
  page.set(iv, 0);
  page.set(cipher, 12); // cipher 长度 = chunkEnc+16 = PAGE_SIZE-12
  return page;
}

/**
 * 密文页 → 逻辑载荷(长度 = chunkEnc,尾部可能零填充;由上层按 n/catalogByteLen 截断)。
 * @param {Uint8Array} page
 * @param {CryptoKey} key
 * @param {number} [chunkEnc]
 */
export async function decryptPage(page, key, chunkEnc = CHUNK_ENC) {
  const iv = page.slice(0, 12);
  const cipher = page.slice(12, 12 + chunkEnc + 16);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
  } catch {
    throw new Error('密码错误或数据库已损坏');
  }
}

/* ---------- 整串辅助(兼容 / 导出) ---------- */

export async function encryptText(plain, password) {
  const salt = randomSalt();
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain)));
  return `AWDB1:${b64(salt)}:${b64(iv)}:${b64(data)}`;
}

export async function decryptText(raw, password) {
  const parts = String(raw).split(':');
  if (parts[0] !== 'AWDB1' || parts.length !== 4) throw new Error('不是有效的加密数据库');
  const key = await deriveKey(password, unb64(parts[1]));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parts[2]) }, key, unb64(parts[3]));
  } catch {
    throw new Error('密码错误或数据库已损坏');
  }
  return td.decode(plain);
}

export function isEncrypted(raw) {
  return typeof raw === 'string' && raw.startsWith('AWDB1:');
}

export const cryptoDb = {
  deriveKey,
  randomSalt,
  encryptPage,
  decryptPage,
  encryptText,
  decryptText,
  isEncrypted,
};
export default cryptoDb;
