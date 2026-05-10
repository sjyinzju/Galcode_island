// 桌宠自定义图片的二进制存储（IndexedDB）。
//
// 为什么不用 zustand persist (localStorage)：
//   - localStorage 容量上限 ~5MB；GIF 单张几百 KB，6 类各 1-3 张轻松撞上限
//   - 二进制走 base64 还要 +33% 体积
// 为什么不直接落盘到磁盘：
//   - 桌面端 Tauri 可以走 fs，但本应用同时跑在浏览器 LAN 模式（虽然该模式
//     基本只读 UI），保留 IDB 路径让两端代码一致；自定义图片本身不需要跨设备同步
//
// 设计：
//   - 单 object store "blobs"，key=自定义资源 id（uuid），value=Blob
//   - 上层 store 持久化"元数据列表"（id / fileName / mime / sizeBytes）到 zustand
//   - 渲染时通过 getAssetUrl(id) 拿一个 ObjectURL（带进程内缓存），删除时 revoke
//   - 不暴露 IDB 句柄；所有 API 异步、幂等

const DB_NAME = "galcode-pet-assets";
const STORE_NAME = "blobs";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    // 环境不支持 IDB（极个别 webview）：返回拒绝；上层会回退到默认资源
    return Promise.reject(new Error("IndexedDB 不可用"));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
  });
  return dbPromise;
}

/// 写入二进制；同 id 覆盖。
export async function putAssetBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB put aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"));
  });
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("IDB get failed"));
  });
}

export async function deleteAssetBlob(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB delete aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IDB delete failed"));
  });
}

// ---------------------------------------------------------------------------
// ObjectURL 缓存：ObjectURL 创建有成本（占内存映射），同一 id 反复渲染只创一次；
// 删除时显式 revoke，避免 webview 长期持有 Blob 引用。
// ---------------------------------------------------------------------------

const urlCache = new Map<string, string>();

/// 拿到 id 对应的 ObjectURL。资源不存在返回 null（调用方 fallback）。
export async function getAssetUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  try {
    const blob = await getAssetBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

/// 删除 id 对应的资源 + 释放 ObjectURL。安全：缺资源 / URL 都 no-op。
export async function removeAssetCompletely(id: string): Promise<void> {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
  try {
    await deleteAssetBlob(id);
  } catch {
    /* 已不存在则无视 */
  }
}
