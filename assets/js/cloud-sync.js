/* RP-Hub cloud account and IndexedDB sync bridge.
 *
 * This module intentionally stays outside the large Vue bundle. It works with
 * both old and new RP-Hub frontends by syncing the existing RPHubDB store.
 * Secrets are removed before upload and preserved locally on download.
 */
(function () {
    'use strict';

    const API_BASE = String(
        window.RPHUB_SYNC_API || 'https://api.20-89-42-182.sslip.io/rphub-sync'
    ).replace(/\/+$/, '');
    const DB_NAME = 'RPHubDB';
    const STORE_NAME = 'store';
    const REFRESH_KEY = 'rphub_sync_refresh_token';
    const META_KEY = 'rphub_sync_meta_v1';
    const POLL_MS = 15000;
    const SECRET_KEYS = new Set([
        'apiKey', 'apiProviderKeys', 'imageGenKey', 'tavilyApiKey',
        'extractorKey', 'embeddingKey', 'secret', 'password',
        'accessToken', 'refreshToken'
    ]);

    const state = {
        user: null,
        status: 'offline',
        error: '',
        accessToken: '',
        cursor: 0,
        docs: {},
        db: null,
        timer: null,
        busy: false
    };

    const textHash = (value) => {
        const text = JSON.stringify(value);
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    };

    const clone = (value) => {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    };

    const scrub = (value) => {
        const result = clone(value);
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            Object.keys(node).forEach((key) => {
                if (SECRET_KEYS.has(key)) delete node[key];
                else walk(node[key]);
            });
        };
        walk(result);
        return result;
    };

    const mergeLocalSecrets = (local, remote) => {
        if (!local || typeof local !== 'object' || !remote || typeof remote !== 'object') {
            return remote;
        }
        if (Array.isArray(local) || Array.isArray(remote)) return remote;
        const result = { ...remote };
        SECRET_KEYS.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(local, key)) result[key] = local[key];
        });
        Object.keys(result).forEach((key) => {
            if (local[key] && result[key] && typeof local[key] === 'object' && typeof result[key] === 'object') {
                result[key] = mergeLocalSecrets(local[key], result[key]);
            }
        });
        return result;
    };

    const readMeta = () => {
        try {
            const value = JSON.parse(localStorage.getItem(META_KEY) || '{}');
            if (value && typeof value === 'object') {
                state.cursor = Number(value.cursor) || 0;
                state.docs = value.docs && typeof value.docs === 'object' ? value.docs : {};
            }
        } catch (_) { }
    };

    const saveMeta = () => {
        try {
            localStorage.setItem(META_KEY, JSON.stringify({
                cursor: state.cursor,
                docs: state.docs
            }));
        } catch (_) { }
    };

    const request = async (path, options = {}, retry = true) => {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
            credentials: 'omit'
        });
        if (response.status === 401 && retry) {
            if (await refresh()) return request(path, options, false);
        }
        let payload = null;
        try { payload = await response.json(); } catch (_) { }
        if (!response.ok) throw new Error(payload?.error || `云端请求失败 (${response.status})`);
        return payload || {};
    };

    const saveTokens = (payload) => {
        state.accessToken = String(payload?.accessToken || '');
        if (payload?.refreshToken) localStorage.setItem(REFRESH_KEY, payload.refreshToken);
    };

    const clearTokens = () => {
        state.accessToken = '';
        localStorage.removeItem(REFRESH_KEY);
    };

    const startPolling = () => {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => sync(), POLL_MS);
    };

    const openDb = () => new Promise((resolve, reject) => {
        if (state.db) return resolve(state.db);
        const req = indexedDB.open(DB_NAME);
        req.onsuccess = () => {
            state.db = req.result;
            resolve(state.db);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });

    const allLocalRecords = async () => {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const keysReq = store.getAllKeys();
            const valuesReq = store.getAll();
            tx.oncomplete = () => {
                const records = [];
                const keys = keysReq.result || [];
                const values = valuesReq.result || [];
                for (let i = 0; i < keys.length; i++) records.push({ key: String(keys[i]), value: values[i] });
                resolve(records);
            };
            tx.onerror = () => reject(tx.error || new Error('IndexedDB 读取失败'));
        });
    };

    const localRecord = async (key) => {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    };

    const putLocalRecord = async (key, value) => {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).put(value, key);
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
    };

    const mapKey = (key) => {
        const prefix = 'rp_hub_';
        const clean = key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key;
        if (clean.indexOf('memories_') === 0) return { type: 'memories', id: clean.slice(9) };
        if (clean.indexOf('chat_') === 0) return { type: 'chat', id: clean.slice(5) };
        return { type: 'idb', id: clean };
    };

    const unmapKey = (type, id) => {
        if (type === 'memories') return `rp_hub_memories_${id}`;
        if (type === 'chat') return `rp_hub_chat_${id}`;
        return `rp_hub_${id}`;
    };

    const collectDocuments = async () => {
        const records = await allLocalRecords();
        return records.map((record) => {
            const mapped = mapKey(record.key);
            const payload = scrub(record.value);
            const key = `${mapped.type}:${mapped.id}`;
            const previous = state.docs[key];
            return {
                type: mapped.type,
                id: mapped.id,
                payload,
                version: Number(previous?.version) || 0,
                updatedAt: Date.now(),
                hash: textHash(payload)
            };
        }).filter((document) => !state.docs[`${document.type}:${document.id}`]
            || state.docs[`${document.type}:${document.id}`].hash !== document.hash);
    };

    const applyDocuments = async (documents) => {
        for (const document of documents || []) {
            if (!document?.type || !document?.id || document.deleted) continue;
            const key = unmapKey(document.type, document.id);
            let value = document.payload;
            if (document.type === 'idb' && document.id === 'settings') {
                value = mergeLocalSecrets(await localRecord(key), value);
            }
            await putLocalRecord(key, value);
            state.docs[`${document.type}:${document.id}`] = {
                version: Number(document.version) || 0,
                hash: textHash(scrub(value))
            };
        }
        saveMeta();
    };

    const splitPushBatches = (documents) => {
        const batches = [];
        let batch = [];
        let batchBytes = 2;
        const maxBatchBytes = 4 * 1024 * 1024;
        for (const document of documents) {
            const documentBytes = JSON.stringify(document).length + 2;
            if (batch.length && (batch.length >= 50 || batchBytes + documentBytes > maxBatchBytes)) {
                batches.push(batch);
                batch = [];
                batchBytes = 2;
            }
            batch.push(document);
            batchBytes += documentBytes;
        }
        if (batch.length) batches.push(batch);
        return batches;
    };

    const refresh = async () => {
        const token = localStorage.getItem(REFRESH_KEY) || '';
        if (!token) return false;
        try {
            const payload = await request('/api/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: token })
            }, false);
            saveTokens(payload);
            const me = await request('/api/auth/me');
            state.user = me.user;
            state.status = 'logged_in';
            return true;
        } catch (_) {
            clearTokens();
            state.user = null;
            state.status = 'offline';
            return false;
        }
    };

    const sync = async ({ pullFirst = false, pushOnly = false } = {}) => {
        if (!state.user || state.busy) return false;
        state.busy = true;
        state.status = 'syncing';
        render();
        try {
            if (pullFirst) {
                const snapshot = await request(`/api/sync/snapshot?cursor=${state.cursor}`);
                await applyDocuments(snapshot.documents);
                state.cursor = Number(snapshot.cursor) || state.cursor;
            }
            const documents = await collectDocuments();
            if (documents.length) {
                for (const batch of splitPushBatches(documents)) {
                    const result = await request('/api/sync/push', {
                        method: 'POST',
                        body: JSON.stringify({ documents: batch })
                    });
                    (result.accepted || []).forEach((item) => {
                        const key = `${item.type}:${item.id}`;
                        const document = batch.find((candidate) => `${candidate.type}:${candidate.id}` === key);
                        if (document) state.docs[key] = { version: Number(item.version) || 0, hash: document.hash };
                    });
                    state.cursor = Number(result.cursor) || state.cursor;
                }
            } else if (!pushOnly) {
                const snapshot = await request(`/api/sync/snapshot?cursor=${state.cursor}`);
                await applyDocuments(snapshot.documents);
                state.cursor = Number(snapshot.cursor) || state.cursor;
            }
            saveMeta();
            state.status = 'logged_in';
            state.error = '';
            render();
            return true;
        } catch (error) {
            state.status = 'error';
            state.error = error.message || '同步失败';
            render();
            return false;
        } finally {
            state.busy = false;
        }
    };

    const auth = async (mode) => {
        const username = document.getElementById('rphub-sync-username')?.value.trim();
        const password = document.getElementById('rphub-sync-password')?.value || '';
        const displayName = document.getElementById('rphub-sync-display-name')?.value.trim() || '';
        if (!username || !password) return;
        state.status = 'checking';
        state.error = '';
        render();
        try {
            const payload = await request(`/api/auth/${mode}`, {
                method: 'POST',
                body: JSON.stringify({ username, password, displayName })
            }, false);
            saveTokens(payload);
            state.user = payload.user;
            state.status = 'logged_in';
            await sync({ pullFirst: mode === 'login' });
            if (mode === 'login') {
                window.location.reload();
                return;
            }
            startPolling();
            render();
        } catch (error) {
            state.status = 'error';
            state.error = error.message || '操作失败';
            render();
        }
    };

    const logout = async () => {
        try {
            await request('/api/auth/logout', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: localStorage.getItem(REFRESH_KEY) || '' })
            }, false);
        } catch (_) { }
        clearTokens();
        state.user = null;
        state.status = 'offline';
        state.error = '';
        if (state.timer) clearInterval(state.timer);
        render();
    };

    const launcherStatus = () => {
        if (state.status === 'logged_in') return { label: '已连接', tone: 'online' };
        if (state.status === 'syncing') return { label: '同步中', tone: 'syncing' };
        if (state.status === 'checking') return { label: '处理中', tone: 'syncing' };
        if (state.status === 'error') return { label: '同步异常', tone: 'error' };
        return { label: '登录云端账户', tone: 'offline' };
    };

    const installStyles = () => {
        if (document.getElementById('rphub-cloud-sync-styles')) return;
        const style = document.createElement('style');
        style.id = 'rphub-cloud-sync-styles';
        style.textContent = `
            #rphub-cloud-sync-launcher {
                position: fixed;
                right: max(14px, env(safe-area-inset-right));
                bottom: max(14px, env(safe-area-inset-bottom));
                z-index: 9998;
                width: 44px;
                height: 44px;
                padding: 0;
                border: 1px solid rgba(199,210,254,.95);
                border-radius: 999px;
                background: rgba(255,255,255,.94);
                color: #4f46e5;
                box-shadow: 0 7px 22px rgba(30,64,175,.16), 0 1px 3px rgba(15,23,42,.08);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
                transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
            }
            #rphub-cloud-sync-launcher:hover,
            #rphub-cloud-sync-launcher:focus-visible {
                transform: translateY(-2px);
                border-color: #818cf8;
                box-shadow: 0 10px 28px rgba(30,64,175,.22), 0 1px 3px rgba(15,23,42,.1);
                outline: none;
            }
            #rphub-cloud-sync-launcher:active { transform: scale(.95); }
            #rphub-cloud-sync-launcher[hidden] { display: none; }
            .rphub-cloud-sync-launcher-icon { width: 21px; height: 21px; }
            .rphub-cloud-sync-launcher-dot {
                position: absolute;
                right: 2px;
                bottom: 2px;
                width: 9px;
                height: 9px;
                border: 2px solid #fff;
                border-radius: 999px;
                background: #94a3b8;
            }
            #rphub-cloud-sync-launcher[data-tone="online"] .rphub-cloud-sync-launcher-dot { background: #22c55e; }
            #rphub-cloud-sync-launcher[data-tone="syncing"] .rphub-cloud-sync-launcher-dot { background: #f59e0b; animation: rphub-cloud-sync-pulse 1.1s ease-in-out infinite; }
            #rphub-cloud-sync-launcher[data-tone="error"] .rphub-cloud-sync-launcher-dot { background: #ef4444; }
            #rphub-cloud-sync-panel {
                position: fixed;
                right: max(14px, env(safe-area-inset-right));
                bottom: calc(max(14px, env(safe-area-inset-bottom)) + 56px);
                z-index: 9999;
                width: min(360px, calc(100vw - 28px));
                max-height: min(620px, calc(100vh - 86px));
                overflow: auto;
                font: 14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                color: #1f2937;
                animation: rphub-cloud-sync-pop .18s ease-out;
            }
            #rphub-cloud-sync-panel > div { background: #fff; border: 1px solid #dbeafe; border-radius: 16px; box-shadow: 0 15px 45px rgba(30,64,175,.18); overflow: hidden; }
            #rphub-cloud-sync-panel .rphub-sync-header { padding: 12px 14px; background: linear-gradient(135deg,#eef2ff,#eff6ff); display: flex; justify-content: space-between; align-items: center; }
            #rphub-cloud-sync-panel .rphub-sync-header-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
            #rphub-cloud-sync-panel .rphub-sync-header-main strong { white-space: nowrap; }
            #rphub-cloud-sync-panel .rphub-sync-close { border: 0; background: transparent; color: #64748b; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
            #rphub-cloud-sync-panel .rphub-sync-close:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; border-radius: 4px; }
            @keyframes rphub-cloud-sync-pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @keyframes rphub-cloud-sync-pulse { 50% { opacity: .45; } }
            @media (prefers-reduced-motion: reduce) {
                #rphub-cloud-sync-launcher, #rphub-cloud-sync-panel { transition: none; animation: none; }
                #rphub-cloud-sync-launcher[data-tone="syncing"] .rphub-cloud-sync-launcher-dot { animation: none; }
            }
            @media (max-width: 480px) {
                #rphub-cloud-sync-panel { width: calc(100vw - 20px); right: 10px; bottom: calc(max(10px, env(safe-area-inset-bottom)) + 56px); max-height: calc(100vh - 78px); }
                #rphub-cloud-sync-launcher { right: max(10px, env(safe-area-inset-right)); bottom: max(10px, env(safe-area-inset-bottom)); }
            }
        `;
        document.head.appendChild(style);
    };

    const renderLauncher = () => {
        const launcher = document.getElementById('rphub-cloud-sync-launcher');
        if (!launcher) return;
        const current = launcherStatus();
        const isPanelOpen = Boolean(document.getElementById('rphub-cloud-sync-panel'));
        launcher.dataset.tone = current.tone;
        launcher.title = current.label;
        launcher.setAttribute('aria-label', current.label);
        launcher.setAttribute('aria-expanded', String(isPanelOpen));
        launcher.hidden = isPanelOpen;
    };

    const mountLauncher = () => {
        installStyles();
        if (!document.getElementById('rphub-cloud-sync-launcher')) {
            document.body.insertAdjacentHTML('beforeend', `
                <button id="rphub-cloud-sync-launcher" type="button" aria-label="登录云端账户" title="登录云端账户" aria-controls="rphub-cloud-sync-panel">
                    <svg class="rphub-cloud-sync-launcher-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M7 18a4.5 4.5 0 01-.6-8.96A5.5 5.5 0 0117 7.5c0 .18-.01.36-.03.53A4 4 0 0118 16h-2.5M12 12.5v7m0 0l-2.5-2.5M12 19.5l2.5-2.5"></path>
                    </svg>
                    <span class="rphub-cloud-sync-launcher-dot" aria-hidden="true"></span>
                </button>`);
            document.getElementById('rphub-cloud-sync-launcher')?.addEventListener('click', openPanel);
        }
        renderLauncher();
    };

    const closePanel = () => {
        document.getElementById('rphub-cloud-sync-panel')?.remove();
        renderLauncher();
    };

    const panelHtml = () => `
        <div id="rphub-cloud-sync-panel" role="dialog" aria-modal="false" aria-labelledby="rphub-sync-title">
            <div>
                <div class="rphub-sync-header">
                    <div class="rphub-sync-header-main">
                        <strong id="rphub-sync-title">云端账户与同步</strong><span id="rphub-sync-status" style="font-size:12px;color:#4f46e5">未登录</span>
                    </div>
                    <button class="rphub-sync-close" id="rphub-sync-close" type="button" aria-label="关闭云端同步面板">×</button>
                </div>
                <div id="rphub-sync-body" style="padding:14px"></div>
            </div>
        </div>`;

    const openPanel = () => {
        mountLauncher();
        if (!document.getElementById('rphub-cloud-sync-panel')) {
            document.body.insertAdjacentHTML('beforeend', panelHtml());
            document.getElementById('rphub-sync-close')?.addEventListener('click', closePanel);
        }
        renderLauncher();
        render();
        document.getElementById('rphub-sync-username')?.focus();
    };

    const render = () => {
        renderLauncher();
        const body = document.getElementById('rphub-sync-body');
        const status = document.getElementById('rphub-sync-status');
        if (!body || !status) return;
        status.textContent = state.status === 'logged_in' ? '已连接'
            : state.status === 'syncing' ? '同步中'
                : state.status === 'checking' ? '处理中'
                    : state.status === 'error' ? '异常' : '未登录';
        if (state.user) {
            body.innerHTML = `
                <div style="font-weight:700">${String(state.user.displayName || state.user.username)}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:2px">${String(state.user.username)}</div>
                <div style="display:flex;gap:8px;margin-top:12px">
                    <button id="rphub-sync-now" style="flex:1;border:0;border-radius:9px;padding:9px;background:#4f46e5;color:#fff;font-weight:700;cursor:pointer" ${state.busy ? 'disabled' : ''}>立即同步</button>
                    <button id="rphub-sync-logout" style="border:0;border-radius:9px;padding:9px 12px;background:#f3f4f6;color:#4b5563;font-weight:700;cursor:pointer">退出</button>
                </div>
                ${state.error ? `<div style="font-size:12px;color:#dc2626;margin-top:8px">${String(state.error)}</div>` : ''}
            `;
            document.getElementById('rphub-sync-now')?.addEventListener('click', () => sync({ pullFirst: true }));
            document.getElementById('rphub-sync-logout')?.addEventListener('click', logout);
            return;
        }
        body.innerHTML = `
            <div style="display:grid;gap:8px">
                <input id="rphub-sync-username" autocomplete="username" placeholder="用户名或邮箱" style="padding:9px;border:1px solid #d1d5db;border-radius:9px">
                <input id="rphub-sync-display-name" placeholder="显示名称（注册可选）" style="padding:9px;border:1px solid #d1d5db;border-radius:9px">
                <input id="rphub-sync-password" type="password" autocomplete="current-password" placeholder="密码（至少 8 位）" style="padding:9px;border:1px solid #d1d5db;border-radius:9px">
                <div style="display:flex;gap:8px">
                    <button id="rphub-sync-login" style="flex:1;border:0;border-radius:9px;padding:9px;background:#4f46e5;color:#fff;font-weight:700;cursor:pointer">登录并同步</button>
                    <button id="rphub-sync-register" style="flex:1;border:0;border-radius:9px;padding:9px;background:#eef2ff;color:#4338ca;font-weight:700;cursor:pointer">注册并上传</button>
                </div>
                <div style="font-size:11px;color:#6b7280">角色卡、聊天、记忆和 embedding 会同步。API Key 只保存在当前设备。</div>
                ${state.error ? `<div style="font-size:12px;color:#dc2626">${String(state.error)}</div>` : ''}
            </div>
        `;
        document.getElementById('rphub-sync-login')?.addEventListener('click', () => auth('login'));
        document.getElementById('rphub-sync-register')?.addEventListener('click', () => auth('register'));
    };

    const boot = async () => {
        mountLauncher();
        readMeta();
        if (localStorage.getItem(REFRESH_KEY)) {
            await refresh();
            if (state.user) {
                await sync();
                startPolling();
            }
        }
    };

    window.RPHubCloudSync = {
        open: openPanel,
        close: closePanel,
        sync: () => sync({ pullFirst: true }),
        request: (path, options = {}) => request(path, options),
        getState: () => ({ user: state.user, status: state.status, error: state.error })
    };

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.getElementById('rphub-cloud-sync-panel')) closePanel();
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
