/* ============================================================
 * AetherWebDatabase —— OPFS 分页文档数据库(独立仓库,webos 子模块引用)
 *
 * 面向 webos 应用(短信 / 邮件 / 日记等)的轻量持久层:
 *   · OPFS 文件 + 4KB 固定页;双超级块原子提交;
 *   · 可选页级 AES-256-GCM(密钥缓存,页独立 IV);
 *   · 同名库句柄单例 + 每库操作串行;
 *   · 集合级 CRUD,单条指令原子;无视图、无跨语句事务。
 * ============================================================ */

export { open, Database, Collection, closeAll } from './database.js';
export {
  createMemoryBackend,
  createOpfsBackend,
  openBackend,
  memoryStorage,
} from './storage.js';
export {
  PAGE_SIZE,
  MAGIC,
  FORMAT_VERSION,
  encodeSuper,
  decodeSuper,
  pickSuper,
  crc32,
} from './page.js';
export {
  deriveKey,
  encryptPage,
  decryptPage,
  encryptText,
  decryptText,
  isEncrypted,
  cryptoDb,
} from './crypto.js';

import { open, Database, Collection, closeAll } from './database.js';
import {
  createMemoryBackend,
  createOpfsBackend,
  openBackend,
  memoryStorage,
} from './storage.js';
import { PAGE_SIZE, encodeSuper, decodeSuper, pickSuper, crc32 } from './page.js';
import { cryptoDb, encryptText, decryptText, isEncrypted } from './crypto.js';

const AetherWebDatabase = {
  open,
  Database,
  Collection,
  closeAll,
  createMemoryBackend,
  createOpfsBackend,
  openBackend,
  memoryStorage,
  PAGE_SIZE,
  encodeSuper,
  decodeSuper,
  pickSuper,
  crc32,
  encryptText,
  decryptText,
  isEncrypted,
  cryptoDb,
};

export default AetherWebDatabase;
