/* ============================================================
 * 页格式 —— 固定页文件 + 双超级块原子提交
 *
 * 文件布局:
 *   page 0  超级块槽 A(明文,含 salt/目录定位/CRC)
 *   page 1  超级块槽 B
 *   page 2+ 数据页(目录链 / 文档分片);页号连续
 *
 * 原子提交(CoW):
 *   1. 只把「当前超级块未引用」的页(空闲页或文件尾扩展)写入新数据
 *   2. 序列化新目录写入新页
 *   3. 把 generation+1 的超级块写入另一槽
 *   任一步失败 → 不翻转超级块,旧 generation 仍然有效。
 *
 * 加密:
 *   · 超级块始终明文(需要读到 salt / 目录位置)
 *   · 数据页: IV(12) || AES-GCM(逻辑页),tag 16 字节附在密文后
 *   · 逻辑页载荷上限 chunkSize = PAGE_SIZE-12-16(加密)或 PAGE_SIZE(明文)
 * ============================================================ */

export const PAGE_SIZE = 4096;
export const MAGIC = 'AWDBPG01';
export const FORMAT_VERSION = 1;
export const SUPER_A = 0;
export const SUPER_B = 1;
export const FIRST_DATA_PAGE = 2;

/** 加密页:iv(12)+tag(16) 占位后,单页逻辑载荷上限 */
export const CHUNK_ENC = PAGE_SIZE - 12 - 16; // 4068
/** 明文页:整页皆可载荷 */
export const CHUNK_PLAIN = PAGE_SIZE;

/* ---------- CRC32(IEEE) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- 超级块编解码(明文,固定布局) ---------- */

/**
 * @typedef {object} Superblock
 * @property {number} version
 * @property {number} pageSize
 * @property {number} chunkSize
 * @property {number} generation
 * @property {0|1} encrypted
 * @property {Uint8Array} salt  16B
 * @property {number} catalogStart
 * @property {number} catalogPages
 * @property {number} catalogByteLen
 * @property {number} pageCount
 */

export function encodeSuper(sb) {
  const buf = new Uint8Array(PAGE_SIZE);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 8; i++) buf[i] = MAGIC.charCodeAt(i);
  dv.setUint32(8, sb.version, true);
  dv.setUint32(12, sb.pageSize, true);
  dv.setUint32(16, sb.chunkSize, true);
  dv.setUint32(20, sb.generation, true);
  buf[24] = sb.encrypted ? 1 : 0;
  buf.set(sb.salt.subarray(0, 16), 28);
  dv.setUint32(44, sb.catalogStart, true);
  dv.setUint32(48, sb.catalogPages, true);
  dv.setUint32(52, sb.catalogByteLen, true);
  dv.setUint32(56, sb.pageCount, true);
  dv.setUint32(60, crc32(buf.subarray(0, 60)), true);
  return buf;
}

/** 解码一页;magic/CRC/version 不符 → null */
export function decodeSuper(page) {
  if (!page || page.length < 64) return null;
  for (let i = 0; i < 8; i++) {
    if (page[i] !== MAGIC.charCodeAt(i)) return null;
  }
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const want = dv.getUint32(60, true);
  if (crc32(page.subarray(0, 60)) !== want) return null;
  const version = dv.getUint32(8, true);
  if (version !== FORMAT_VERSION) return null;
  const pageSize = dv.getUint32(12, true);
  if (pageSize !== PAGE_SIZE) return null;
  const encrypted = page[24] ? 1 : 0;
  const salt = page.slice(28, 44);
  return {
    version,
    pageSize,
    chunkSize: dv.getUint32(16, true),
    generation: dv.getUint32(20, true),
    encrypted,
    salt,
    catalogStart: dv.getUint32(44, true),
    catalogPages: dv.getUint32(48, true),
    catalogByteLen: dv.getUint32(52, true),
    pageCount: dv.getUint32(56, true),
  };
}

/** 在 A/B 两槽中选出 generation 更大且 CRC 合法的一块;都无效 → null */
export function pickSuper(pageA, pageB) {
  const a = decodeSuper(pageA);
  const b = decodeSuper(pageB);
  if (a && b) return a.generation >= b.generation ? a : b;
  return a || b;
}

/** 新建初始超级块(generation=1) */
export function initSuper({ encrypted, salt, catalogStart, catalogPages, catalogByteLen, pageCount, chunkSize }) {
  return {
    version: FORMAT_VERSION,
    pageSize: PAGE_SIZE,
    chunkSize,
    generation: 1,
    encrypted: encrypted ? 1 : 0,
    salt,
    catalogStart,
    catalogPages,
    catalogByteLen,
    pageCount,
  };
}

/* ---------- 目录 / 文档在逻辑层的形状 ---------- */

/**
 * 目录 JSON:
 * {
 *   free: number[],          // 空闲页号(不含超级块)
 *   cols: {
 *     [name]: {
 *       seq: number,
 *       docs: { [id]: { p: number[], n: number } }  // p=页列表, n=字节长
 *     }
 *   }
 * }
 */
export function emptyCatalog() {
  return { free: [], cols: {} };
}

/** 文档字节 → 页号列表分片写入 dirty 映射所需页数 */
export function pagesNeeded(byteLen, chunkSize) {
  if (byteLen <= 0) return 1; // 空文档也占 1 页,便于统一读写
  return Math.ceil(byteLen / chunkSize);
}

export function chunkOf(bytes, index, chunkSize) {
  const start = index * chunkSize;
  return bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
}
