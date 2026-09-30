// ==UserScript==
// @name         小鹅通考试批量管理工具
// @namespace    http://tampermonkey.net/
// @version      1.6.2
// @description  批量处理小鹅通考试重复副本，支持重复检测、课包级清理（删课包连带考试副本）、批量删除、日期筛选
// @author       YourName
// @match        https://admin.xiaoe-tech.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_info
// @require      https://cdn.jsdelivr.net/npm/sweetalert2@11
// @updateURL    https://raw.githubusercontent.com/DavidLiu0536/xiaoe-batch-delete-plugin/main/tampermonkey-script.js
// @downloadURL  https://raw.githubusercontent.com/DavidLiu0536/xiaoe-batch-delete-plugin/main/tampermonkey-script.js
// ==/UserScript==

(function() {
    'use strict';

    class XiaoeExamManager {
        constructor() {
            this.examList = [];
            this.duplicateGroups = [];
            this.originalExams = new Map();
            this.init();
        }

        async init() {
            const ver = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || 'unknown';
            console.log(`📚 小鹅通考试批量管理工具已加载 v${ver}`);
            this.capturedRequests = []; // 页面真实API请求签名 {url, method, body, sample}
            this.injectPageHook();      // 必须在页面JS发请求前注入
            this.listenCapturedRequests();
            this.addPluginUI();
        }

        // 已确认的真实接口签名（从 api-captures.json 学到的，作为内置默认）
        getBuiltinSignatures() {
            const appId = (typeof unsafeWindow !== 'undefined' && (unsafeWindow.APPID || unsafeWindow.app_id)) || '';
            return {
                examList: {
                    url: '/xe.exam.examination_list', method: 'POST',
                    body: 'page_size=50&page_index=1&search_content=&status=0&teacher_id='
                },
                examDelete: {
                    url: '/xe.exam.change_exam_status', method: 'POST',
                    body: 'exam_id=__ID__&state=2'   // state=2 = 删除/回收
                },
                courseList: {
                    url: '/xe.course.b_admin_r.camp_pro.list/2.0.0', method: 'POST',
                    body: `app_id=${appId}&search_content=&order_by=modify&order_type=1&page_index=1&page_size=50&sale_status=-1&created_source=1`
                },
                courseDelete: {
                    url: '/xe.course.b_admin_w.batch.remove/1.0.0', method: 'POST',
                    body: 'resource_ids%5B0%5D=__ID__'  // 支持 resource_ids[0]=a&resource_ids[1]=b 批量
                },
                courseCatalog: {
                    url: '/xe.course.b_admin_r.camp_pro.chapter.all.list.get/1.0.0', method: 'POST',
                    body: JSON.stringify({ app_id: appId, course_id: '__ID__', sub_course_id: '' })
                }
            };
        }

        // 向页面上下文注入hook，捕获页面自身的 fetch/XHR 请求
        // Tampermonkey在隔离沙箱中运行，直接改 window.fetch 拦截不到页面请求。
        // 优先用 unsafeWindow 直接改页面window；不行再注入<script>标签
        injectPageHook() {
            const installHookOnWindow = (win) => {
                if (win.__xiaoeHookInstalled) return true;
                win.__xiaoeHookInstalled = true;

                const interesting = (url) =>
                    typeof url === 'string' && /\/xe\.|exam/i.test(url);

                const report = (entry) => {
                    try { win.postMessage({ __xiaoe_capture: true, entry }, '*'); } catch (e) {}
                };

                const normalizeHeaders = (h) => {
                    const out = {};
                    try {
                        if (!h) return out;
                        if (typeof h.forEach === 'function') h.forEach((v, k) => out[k] = v);
                        else if (Array.isArray(h)) h.forEach(([k, v]) => out[k] = v);
                        else if (typeof h === 'object') Object.assign(out, h);
                    } catch (e) {}
                    return out;
                };

                const origFetch = win.fetch;
                win.fetch = function(...args) {
                    let url = '', method = 'GET', body = null, headers = null;
                    try {
                        if (typeof args[0] === 'string') url = args[0];
                        else if (args[0] && args[0].url) url = args[0].url;
                        const opts = args[1] || {};
                        method = (opts.method || (args[0] && args[0].method) || 'GET').toUpperCase();
                        body = opts.body || null;
                        headers = normalizeHeaders(opts.headers || (args[0] && args[0].headers));
                    } catch (e) {}

                    const p = origFetch.apply(this, args);
                    if (interesting(url)) {
                        p.then(resp => {
                            resp.clone().text().then(text => {
                                report({ url, method, body: String(body).slice(0, 2000), headers, response: text.slice(0, 40000) });
                            }).catch(() => {});
                        }).catch(() => {});
                    }
                    return p;
                };

                const origOpen = win.XMLHttpRequest.prototype.open;
                const origSend = win.XMLHttpRequest.prototype.send;
                const origSetRH = win.XMLHttpRequest.prototype.setRequestHeader;
                win.XMLHttpRequest.prototype.open = function(method, url) {
                    this.__xiaoeUrl = url;
                    this.__xiaoeMethod = method;
                    this.__xiaoeHeaders = {};
                    return origOpen.apply(this, arguments);
                };
                win.XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
                    try { (this.__xiaoeHeaders = this.__xiaoeHeaders || {})[k] = v; } catch (e) {}
                    return origSetRH.apply(this, arguments);
                };
                win.XMLHttpRequest.prototype.send = function(body) {
                    const url = this.__xiaoeUrl;
                    if (interesting(url)) {
                        const reqHeaders = this.__xiaoeHeaders || {};
                        this.addEventListener('load', () => {
                            let resp = '';
                            try {
                                // responseType='json' 时 responseText 会抛异常，要用 response
                                if (!this.responseType || this.responseType === 'text') {
                                    resp = String(this.responseText);
                                } else if (this.responseType === 'json') {
                                    resp = JSON.stringify(this.response);
                                } else {
                                    resp = String(this.response);
                                }
                            } catch (e) { resp = '[read-failed:' + e.message + ']'; }
                            report({
                                url, method: this.__xiaoeMethod || 'GET',
                                body: String(body).slice(0, 2000),
                                headers: reqHeaders,
                                response: resp.slice(0, 40000)
                            });
                        });
                    }
                    return origSend.apply(this, arguments);
                };
                return true;
            };

            // 方式1: unsafeWindow（Tampermonkey直接操作页面window，无CSP限制）
            try {
                if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.fetch) {
                    installHookOnWindow(unsafeWindow);
                    console.log('📡 [v1.4.0] hook已通过unsafeWindow注入页面上下文');
                    unsafeWindow.postMessage({ __xiaoe_capture: true, entry: { url: '__hook_ready__', method: 'INFO', body: null, response: 'unsafeWindow hook' } }, '*');
                    return;
                }
            } catch (e) {
                console.log('⚠️ unsafeWindow不可用，尝试script注入:', e.message);
            }

            // 方式2: script标签注入（兜底，可能被CSP拦截）
            const hookCode = `
                (function() {
                    if (window.__xiaoeHookInstalled) return;
                    window.__xiaoeHookInstalled = true;

                    const TAG = 'XIAOE_API_CAPTURE';
                    const interesting = (url) =>
                        typeof url === 'string' && /\\/xe\\.|exam/i.test(url);

                    function report(entry) {
                        try {
                            window.postMessage({ __xiaoe_capture: true, entry }, '*');
                        } catch (e) {}
                    }

                    const normalizeHeaders = (h) => {
                        const out = {};
                        try {
                            if (!h) return out;
                            if (typeof h.forEach === 'function') h.forEach((v, k) => out[k] = v);
                            else if (Array.isArray(h)) h.forEach(([k, v]) => out[k] = v);
                            else if (typeof h === 'object') Object.assign(out, h);
                        } catch (e) {}
                        return out;
                    };

                    // --- hook fetch ---
                    const origFetch = window.fetch;
                    window.fetch = function(...args) {
                        let url = '', method = 'GET', body = null, headers = null;
                        try {
                            if (typeof args[0] === 'string') url = args[0];
                            else if (args[0] && args[0].url) url = args[0].url;
                            const opts = args[1] || {};
                            method = (opts.method || (args[0] && args[0].method) || 'GET').toUpperCase();
                            body = opts.body || null;
                            headers = normalizeHeaders(opts.headers || (args[0] && args[0].headers));
                        } catch (e) {}

                        const p = origFetch.apply(this, args);
                        if (interesting(url)) {
                            p.then(resp => {
                                resp.clone().text().then(text => {
                                    report({ url, method, body: String(body).slice(0, 2000), headers, response: text.slice(0, 40000) });
                                }).catch(() => {});
                            }).catch(() => {});
                        }
                        return p;
                    };

                    // --- hook XHR ---
                    const origOpen = XMLHttpRequest.prototype.open;
                    const origSend = XMLHttpRequest.prototype.send;
                    const origSetRH = XMLHttpRequest.prototype.setRequestHeader;
                    XMLHttpRequest.prototype.open = function(method, url) {
                        this.__xiaoeUrl = url;
                        this.__xiaoeMethod = method;
                        this.__xiaoeHeaders = {};
                        return origOpen.apply(this, arguments);
                    };
                    XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
                        try { (this.__xiaoeHeaders = this.__xiaoeHeaders || {})[k] = v; } catch (e) {}
                        return origSetRH.apply(this, arguments);
                    };
                    XMLHttpRequest.prototype.send = function(body) {
                        const url = this.__xiaoeUrl;
                        if (interesting(url)) {
                            const reqHeaders = this.__xiaoeHeaders || {};
                            this.addEventListener('load', () => {
                                let resp = '';
                                try {
                                    if (!this.responseType || this.responseType === 'text') {
                                        resp = String(this.responseText);
                                    } else if (this.responseType === 'json') {
                                        resp = JSON.stringify(this.response);
                                    } else {
                                        resp = String(this.response);
                                    }
                                } catch (e) { resp = '[read-failed]'; }
                                report({
                                    url, method: this.__xiaoeMethod || 'GET',
                                    body: String(body).slice(0, 2000),
                                    headers: reqHeaders,
                                    response: resp.slice(0, 40000)
                                });
                            });
                        }
                        return origSend.apply(this, arguments);
                    };

                    window.postMessage({ __xiaoe_capture: true, entry: { url: '__hook_ready__', method: 'INFO', body: null, response: 'page hook installed' } }, '*');
                })();
            `;
            // document-start 时 documentElement 可能尚未创建，需等待
            const doInject = () => {
                const target = document.documentElement || document.head || document.body;
                if (!target) return false;
                const script = document.createElement('script');
                script.textContent = hookCode;
                target.appendChild(script);
                script.remove();
                console.log('📡 [v1.4.0] 页面hook已注入（document-start），等待捕获API请求...');
                return true;
            };
            if (!doInject()) {
                const obs = new MutationObserver(() => {
                    if (doInject()) obs.disconnect();
                });
                obs.observe(document, { childList: true, subtree: true });
            }
        }

        // 接收页面hook传回的请求记录
        listenCapturedRequests() {
            window.addEventListener('message', (event) => {
                // 注意：沙箱里的 window 是包装对象，event.source 是页面真实window，
                // 不能用 === 比较，只能靠消息里的标记字段识别
                if (!event.data || event.data.__xiaoe_capture !== true) return;
                const entry = event.data.entry;
                if (!entry) return;

                if (entry.url === '__hook_ready__') {
                    console.log('✅ [v1.4.0] 页面hook就绪');
                    return;
                }

                this.capturedRequests.push(entry);
                const shortUrl = entry.url.length > 120 ? entry.url.slice(0, 120) + '...' : entry.url;
                console.log(`📡 捕获API #${this.capturedRequests.length}: ${entry.method} ${shortUrl}`);
                this.reportSignatureToServer(entry);

                // 找出考试列表接口：响应里含 ex_ 开头的资源
                if (!this.examListApiSignature) {
                    try {
                        const data = JSON.parse(entry.response);
                        const str = JSON.stringify(data);
                        if (/"ex_[A-Za-z0-9_]+"/.test(str) && /list|total|exam/i.test(entry.url)) {
                            this.examListApiSignature = { url: entry.url, method: entry.method, body: entry.body, sample: data };
                            console.log('🎯 识别到考试列表API:', entry.url);
                            this.updateStatus('已捕获考试列表API，点击"检测重复考试"开始', 'success');
                        }
                    } catch (e) {}
                }

                // 识别课程/课包列表接口：响应含 course_ 或 camp_ 开头的资源
                if (!this.courseListApiSignature) {
                    try {
                        const data = JSON.parse(entry.response);
                        const str = JSON.stringify(data);
                        if (/"(course|camp|pkg|package)_[A-Za-z0-9_]+"/.test(str) && /list/i.test(entry.url)) {
                            this.courseListApiSignature = { url: entry.url, method: entry.method, body: entry.body, sample: data };
                            console.log('🎯 识别到课程列表API:', entry.url);
                        }
                    } catch (e) {}
                }

                // 记录删除类接口（删考试/删课包时复用签名）
                // 小鹅通的删除是 change_exam_status?state=2 这类"改状态"接口
                if (/delet|remove|recycle|drop|change_exam_status|change.*status/i.test(entry.url)) {
                    this.deleteApiCandidates = this.deleteApiCandidates || [];
                    this.deleteApiCandidates.push(entry);
                    console.log('🎯 捕获到删除类接口:', entry.method, entry.url);
                    this.updateStatus(`已学习删除接口: ${entry.url.split('/').pop()}`, 'success');
                }
            });
        }

        // 重放捕获到的API请求，自行分页拉取全部考试（不再点DOM翻页）
        async fetchAllExamsViaApi(signature) {
            const { url, method, body } = signature;
            const all = [];
            let page = 1;
            const pageSize = 50;

            const buildBody = (p) => {
                if (!body) return null;
                try {
                    const obj = JSON.parse(body);
                    // 常见的分页字段都试着覆盖
                    ['page', 'page_index', 'pageIndex'].forEach(k => { if (k in obj) obj[k] = p; });
                    ['page_size', 'pageSize', 'size', 'limit'].forEach(k => { if (k in obj) obj[k] = pageSize; });
                    return JSON.stringify(obj);
                } catch (e) {
                    // 表单格式 page_index=1&page_size=10
                    let s = String(body);
                    if (/page_index=/.test(s)) s = s.replace(/page_index=\d*/, 'page_index=' + p);
                    else if (/page=/.test(s)) s = s.replace(/(?<![a-z_])page=\d*/, 'page=' + p);
                    if (/page_size=/.test(s)) s = s.replace(/page_size=\d*/, 'page_size=' + pageSize);
                    else if (/pageSize=/.test(s)) s = s.replace(/pageSize=\d*/, 'pageSize=' + pageSize);
                    return s;
                }
            };

            while (page <= 100) {
                const fetchOpts = { method: method || 'POST', credentials: 'include' };
                if (method === 'GET') {
                    // GET: 换query参数
                    let u = url;
                    if (/page_index=\d*/.test(u)) u = u.replace(/page_index=\d*/, 'page_index=' + page);
                    else if (/([?&])page=\d*/.test(u)) u = u.replace(/([?&])page=\d*/, '$1page=' + page);
                    else u += (u.includes('?') ? '&' : '?') + 'page_index=' + page;
                    if (/page_size=\d*/.test(u)) u = u.replace(/page_size=\d*/, 'page_size=' + pageSize);
                    else u += '&page_size=' + pageSize;
                    const r = await fetch(u, fetchOpts);
                    const data = await r.json();
                    const items = this.extractExamArray(data);
                    if (!items.length) break;
                    all.push(...items);
                    console.log(`📥 API第${page}页: ${items.length}条 (累计${all.length})`);
                    this.updateStatus(`API拉取中... 第${page}页，累计${all.length}条`);
                    if (items.length < pageSize) break;
                } else {
                    fetchOpts.headers = { 'Content-Type': body && body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded' };
                    fetchOpts.body = buildBody(page);
                    const r = await fetch(url, fetchOpts);
                    const data = await r.json();
                    const items = this.extractExamArray(data);
                    if (!items.length) break;
                    all.push(...items);
                    console.log(`📥 API第${page}页: ${items.length}条 (累计${all.length})`);
                    this.updateStatus(`API拉取中... 第${page}页，累计${all.length}条`);
                    if (items.length < pageSize) break;
                }
                page++;
                await this.sleep(300);
            }
            return all;
        }

        // 从API响应中提取考试数组（适配多种嵌套结构）
        extractExamArray(data) {
            const candidates = [
                data?.data?.list, data?.data?.exam_list, data?.data?.items,
                data?.data, data?.list, data?.exam_list
            ];
            for (const c of candidates) {
                if (Array.isArray(c) && c.length && c[0] && typeof c[0] === 'object') {
                    // 确认是考试：id或resource_id以ex_开头，或有name/title字段
                    const first = c[0];
                    const id = first.id || first.resource_id || '';
                    if (String(id).startsWith('ex_') || first.name || first.title || first.exam_name) {
                        return c;
                    }
                }
            }
            return [];
        }

        // 归一化API返回的考试对象
        normalizeApiExam(exam, index) {
            return {
                index,
                id: exam.id || exam.resource_id || exam.exam_id || '',
                name: exam.name || exam.title || exam.exam_name || '',
                course: exam.course_title || exam.course_name || '',
                createTime: exam.created_at || exam.create_time || exam.createdAt || '',
                resource_id: exam.resource_id || exam.id || '',
                raw: exam
            };
        }

        // 把捕获到的接口签名上报到本地debug服务器（方便我直接看到真实端点）
        reportSignatureToServer(entry) {
            if (!this._reportedSigs) this._reportedSigs = new Set();
            const key = entry.method + ' ' + entry.url.split('?')[0];
            if (this._reportedSigs.has(key)) return;
            this._reportedSigs.add(key);
            fetch('http://127.0.0.1:5031/api/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    method: entry.method,
                    url: entry.url,
                    body: entry.body,
                    responseSample: String(entry.response).slice(0, 3000)
                })
            }).catch(() => {});
        }

        // 从API响应里递归找出第一个对象数组（不限于考试）
        extractArrayDeep(data) {
            const tryArr = (arr) => Array.isArray(arr) && arr.length && arr.every(x => x && typeof x === 'object') ? arr : null;
            const paths = [
                data?.data?.list, data?.data?.items, data?.data?.exam_list,
                data?.data?.courses, data?.data?.data, data?.list, data?.items, data?.data
            ];
            for (const p of paths) { const r = tryArr(p); if (r) return r; }
            // 递归一层
            if (data && typeof data === 'object') {
                for (const k of Object.keys(data)) {
                    const v = data[k];
                    if (v && typeof v === 'object' && !Array.isArray(v)) {
                        for (const kk of Object.keys(v)) {
                            const r = tryArr(v[kk]);
                            if (r) return r;
                        }
                    }
                }
            }
            return [];
        }

        // 通用分页拉取：按捕获的签名重放请求直到拿全
        async replayPagedList(signature, pageSize = 50) {
            const { url, method, body } = signature;
            const all = [];
            let page = 1;
            const buildBody = (p) => {
                if (!body) return null;
                const s = String(body);
                if (s.trim().startsWith('{')) {
                    const obj = JSON.parse(s);
                    ['page', 'page_index', 'pageIndex'].forEach(k => { if (k in obj) obj[k] = p; });
                    ['page_size', 'pageSize', 'size', 'limit'].forEach(k => { if (k in obj) obj[k] = pageSize; });
                    return JSON.stringify(obj);
                }
                let out = s;
                if (/page_index=/.test(out)) out = out.replace(/page_index=\d*/, 'page_index=' + p);
                else if (/([?&]|^)page=\d*/.test(out)) out = out.replace(/([?&]|^)page=\d*/, '$1page=' + p);
                else out += '&page_index=' + p;
                if (/page_size=/.test(out)) out = out.replace(/page_size=\d*/, 'page_size=' + pageSize);
                else if (/pageSize=/.test(out)) out = out.replace(/pageSize=\d*/, 'pageSize=' + pageSize);
                else out += '&page_size=' + pageSize;
                return out;
            };
            while (page <= 200) {
                let u = url, opts = { method: method || 'POST', credentials: 'include' };
                if ((method || 'GET').toUpperCase() === 'GET') {
                    if (/page_index=\d*/.test(u)) u = u.replace(/page_index=\d*/, 'page_index=' + page);
                    else if (/([?&])page=\d*/.test(u)) u = u.replace(/([?&])page=\d*/, '$1page=' + page);
                    else u += (u.includes('?') ? '&' : '?') + 'page_index=' + page;
                    if (/page_size=\d*/.test(u)) u = u.replace(/page_size=\d*/, 'page_size=' + pageSize);
                    else u += '&page_size=' + pageSize;
                } else {
                    opts.headers = { 'Content-Type': body && body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded' };
                    opts.body = buildBody(page);
                }
                const r = await fetch(u, opts);
                const data = await r.json();
                const items = this.extractArrayDeep(data);
                if (!items.length) break;
                all.push(...items);
                console.log(`📥 第${page}页: ${items.length}条 (累计${all.length})`);
                if (items.length < pageSize) break;
                page++;
                await this.sleep(300);
            }
            return all;
        }

        // 通用ID重放：对单个资源执行写操作（如删除）
        // sig.body 里可能是 __ID__ 占位符（内置签名）或真实ID（捕获签名），两种都处理
        async replayWriteApi(sig, newId) {
            const opts = { method: sig.method || 'POST', credentials: 'include' };
            let url = sig.url;
            // 复用捕获到的真实请求头（删掉会干扰重放的 hop-by-hop 头）
            const headers = {};
            if (sig.headers && typeof sig.headers === 'object') {
                for (const [k, v] of Object.entries(sig.headers)) {
                    if (/^(host|content-length|connection|origin|referer|accept-encoding|cookie)$/i.test(k)) continue;
                    headers[k] = v;
                }
            }
            if ((sig.method || 'GET').toUpperCase() === 'GET') {
                url = url.replace('__ID__', newId).replace(/(ex|course|camp|pkg|a|p)_[A-Za-z0-9_]+/, newId);
            } else {
                let body = String(sig.body);
                if (body.includes('__ID__')) {
                    body = body.replace(/__ID__/g, newId);
                } else {
                    body = body.replace(/(ex|course|camp|pkg|a|p)_[A-Za-z0-9_]+/, newId);
                }
                opts.body = body;
                if (!Object.keys(headers).some(k => /^content-type$/i.test(k))) {
                    headers['Content-Type'] = body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded';
                }
            }
            if (Object.keys(headers).length) opts.headers = headers;
            console.log(`📤 删除请求: ${opts.method} ${url} body=${opts.body || '-'} headers=${JSON.stringify(headers)}`);
            const r = await fetch(url, opts);
            const text = await r.text();
            console.log(`📥 删除响应 [${r.status}]:`, text.slice(0, 500));
            try { return JSON.parse(text); } catch (e) { return { code: -999, raw: text, httpStatus: r.status }; }
        }

        // ============ 课包级清理：删课包连带其考试副本 ============

        // 获取课程目录里的考试（内置camp_pro目录接口 + 捕获签名兜底）
        async getCourseExams(courseId) {
            const builtin = this.getBuiltinSignatures().courseCatalog;
            const catSig = (this.capturedRequests || []).find(r => /chapter.*list|all\.list/i.test(r.url));
            const tryEndpoints = [];
            if (catSig) tryEndpoints.push({ url: catSig.url.replace(/(course|camp|a|pkg|ex)_[A-Za-z0-9_]+/g, courseId), method: catSig.method, body: catSig.body && String(catSig.body).replace(/(course|camp|a|pkg|ex)_[A-Za-z0-9_]+/g, courseId) });
            tryEndpoints.push({ url: builtin.url, method: builtin.method, body: builtin.body.replace('__ID__', courseId) });

            for (const ep of tryEndpoints) {
                try {
                    const opts = { method: ep.method, credentials: 'include' };
                    if (ep.method !== 'GET') {
                        opts.body = ep.body;
                        opts.headers = { 'Content-Type': String(ep.body || '').trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded' };
                    }
                    const r = await fetch(ep.url, opts);
                    const data = await r.json();
                    if (data.code !== 0) continue;
                    const items = this.extractArrayDeep(data);
                    // 目录里 resource_type===27 是考试；也兼容含 ex_ id 的项
                    const exams = items.filter(x =>
                        x.resource_type === 27 ||
                        String(x.resource_id || x.id || '').startsWith('ex_')
                    );
                    if (exams.length || items.length) {
                        console.log(`📦 课程 ${courseId}: 目录${items.length}项，其中考试${exams.length}个`);
                        return exams.map(x => x.resource_id || x.id).filter(Boolean);
                    }
                } catch (e) {}
            }
            return [];
        }

        // 按创建时间筛选课包并分析其考试副本
        async analyzeCoursePackages() {
            this.updateStatus('正在分析课包...');
            // 优先用捕获的签名，没有就用内置的 camp_pro.list
            const sig = this.courseListApiSignature || this.getBuiltinSignatures().courseList;
            console.log('🎯 课包列表API:', sig.url);

            const dateFilter = this.getDateFilter();
            const courses = await this.replayPagedList(sig);
            console.log(`📚 共拉取 ${courses.length} 个课程`);

            const filtered = courses.filter(c => {
                const t = new Date(c.created_at || c.create_time || c.createdAt || c.createTime || c.show_create_time || 0);
                // 日期无法解析时：若设了筛选则排除（防止误选），否则保留
                if (isNaN(t)) return !(dateFilter.startDate || dateFilter.endDate);
                if (dateFilter.startDate && t < dateFilter.startDate) return false;
                if (dateFilter.endDate && t > new Date(dateFilter.endDate.getTime() + 86400000)) return false;
                return true;
            });
            console.log(`📅 时间范围内课包: ${filtered.length} 个`);

            this.coursePlan = [];
            for (const c of filtered) {
                const cid = c.resource_id || c.id || c.course_id;  // camp_pro.list返回的是resource_id
                if (!cid) { console.log('⚠️ 课程无ID字段:', Object.keys(c)); continue; }
                const examIds = await this.getCourseExams(cid);
                this.coursePlan.push({ course: c, courseId: cid, examIds });
                await this.sleep(200);
            }
            this.renderCoursePlan();
        }

        // 展示课包分析结果
        renderCoursePlan() {
            const resultsDiv = document.getElementById('xiaoe-plugin-results');
            if (!resultsDiv) return;
            const totalExams = this.coursePlan.reduce((s, p) => s + p.examIds.length, 0);
            resultsDiv.innerHTML = `
                <div class="xiaoe-duplicate-list">
                    <div class="xiaoe-result-header">📦 课包分析：${this.coursePlan.length} 个课包，共 ${totalExams} 个考试副本</div>
                    ${this.coursePlan.map((p, i) => `
                        <div class="xiaoe-exam-item">
                            <input type="checkbox" class="xiaoe-course-checkbox" data-index="${i}" checked>
                            <span class="xiaoe-exam-name">${(p.course.title || p.course.name || p.courseId)}</span>
                            <span class="xiaoe-badge xiaoe-badge-duplicate">${p.examIds.length} 考试</span>
                            <span class="xiaoe-exam-time">${p.course.created_at || ''}</span>
                        </div>`).join('')}
                </div>`;
            this.updateStatus(`分析完成：${this.coursePlan.length}个课包，${totalExams}个考试副本`, 'success');
            const delBtn = document.getElementById('xiaoe-delete-courses');
            if (delBtn) delBtn.disabled = this.coursePlan.length === 0;
        }

        // 删除选中课包及其考试副本
        async deleteCoursePackages() {
            if (!this.coursePlan || !this.coursePlan.length) {
                this.updateStatus('请先点"分析课包"', 'warning');
                return;
            }
            const checked = Array.from(document.querySelectorAll('.xiaoe-course-checkbox:checked')).map(cb => this.coursePlan[+cb.dataset.index]);
            if (!checked.length) { this.updateStatus('没有勾选课包', 'warning'); return; }

            // 删除签名：优先用捕获的，没有就用已验证的内置接口
            const builtin = this.getBuiltinSignatures();
            let examDel = this.findCapturedApi(/delet|remove|recycle|change_exam_status|change.*status/i, /ex_/, /state=["']?2|"state":2/)
                       || this.findCapturedApi(/delet|remove|recycle|change_exam_status|change.*status/i, /ex_/)
                       || builtin.examDelete;
            let courseDel = this.findCapturedApi(/batch\.remove|delet|remove|recycle|change.*status/i, /(course|camp|pkg|a|p)_/)
                       || builtin.courseDelete;

            console.log('🗑️ 考试删除接口:', examDel.url, '| body:', examDel.body);
            console.log('🗑️ 课包删除接口:', courseDel.url, '| body:', courseDel.body);

            const totalExams = checked.reduce((s, p) => s + p.examIds.length, 0);
            const ok = typeof Swal !== 'undefined' ? (await Swal.fire({
                title: '确认删除？',
                html: `将删除 <b>${checked.length}</b> 个课包 + <b>${totalExams}</b> 个考试副本<br><small>不可恢复！输入 DELETE 确认</small>`,
                icon: 'warning', input: 'text', inputPlaceholder: 'DELETE',
                inputValidator: v => v !== 'DELETE' ? '请输入 DELETE' : null,
                showCancelButton: true, confirmButtonText: '删除', confirmButtonColor: '#f44336'
            })).isConfirmed : confirm(`删除${checked.length}个课包和${totalExams}个考试？`);
            if (!ok) return;

            let okC = 0, okE = 0, fail = 0;
            const totalOps = checked.length + totalExams;
            let doneOps = 0;
            this.updateProgress(0, totalOps, '开始删除');
            for (const p of checked) {
                // 先删课包：考试副本绑在课包上，绑定时删考试后端会报
                // "Trying to get property of non-object"。删包可能连带清空内容。
                try {
                    this.updateProgress(doneOps, totalOps, `课包 ${p.name || p.courseId}`);
                    const r = await this.replayWriteApi(courseDel, p.courseId);
                    r.code === 0 ? okC++ : (fail++, console.log(`❌ 删课包失败 ${p.courseId}:`, r.msg || r.message));
                } catch (e) { fail++; console.log(`❌ 删课包异常 ${p.courseId}:`, e.message); }
                doneOps++;
                this.updateProgress(doneOps, totalOps, `课包 ${okC}/${checked.length}`);
                this.updateStatus(`进度：课包 ${okC}/${checked.length}，考试 ${okE}/${totalExams}，失败 ${fail}`);
                await this.sleep(400);
                // 再删考试副本（若已随课包删除，接口会返回非0，仅记录不算大问题）
                for (const exId of p.examIds) {
                    try {
                        const r = await this.replayWriteApi(examDel, exId);
                        r.code === 0 ? okE++ : (fail++, console.log(`❌ 删考试失败 ${exId}:`, r.msg || r.message));
                    } catch (e) { fail++; }
                    doneOps++;
                    this.updateProgress(doneOps, totalOps, `考试 ${okE}/${totalExams}`);
                    await this.sleep(250);
                }
                this.updateStatus(`进度：课包 ${okC}/${checked.length}，考试 ${okE}/${totalExams}，失败 ${fail}`);
            }
            this.updateStatus(`完成：删课包${okC}个，删考试${okE}个，失败${fail}`, fail ? 'warning' : 'success');
            setTimeout(() => this.hideProgress(), 3000);
        }

        // 添加插件UI
        addPluginUI() {
            // 等待页面加载完成
            const checkExist = setInterval(() => {
                const toolbar = document.querySelector('.exam-toolbar') ||
                               document.querySelector('.toolbar') ||
                               document.querySelector('.page-header') ||
                               document.querySelector('.header') ||
                               document.body;

                if (toolbar && !document.querySelector('#xiaoe-plugin-container')) {
                    clearInterval(checkExist);
                    this.createToolbar(toolbar);
                }
            }, 500);

            // 10秒后停止检查
            setTimeout(() => clearInterval(checkExist), 10000);
        }

        createToolbar(toolbar) {
            const pluginContainer = document.createElement('div');
            pluginContainer.id = 'xiaoe-plugin-container';
            pluginContainer.innerHTML = `
                <div class="xiaoe-plugin-wrapper">
                    <div class="xiaoe-plugin-header">
                        <span class="xiaoe-plugin-title">📚 考试批量管理工具</span>
                        <button class="xiaoe-toggle-btn" id="xiaoe-toggle-panel">−</button>
                    </div>
                    <div class="xiaoe-plugin-content" id="xiaoe-plugin-content">
                        <div class="xiaoe-filter-section">
                            <label class="xiaoe-filter-label">📅 时间筛选：</label>
                            <input type="date" id="xiaoe-start-date" class="xiaoe-date-input" placeholder="开始日期">
                            <span class="xiaoe-date-separator">至</span>
                            <input type="date" id="xiaoe-end-date" class="xiaoe-date-input" placeholder="结束日期">
                            <button id="xiaoe-clear-filter" class="xiaoe-btn xiaoe-btn-small">清除筛选</button>
                        </div>
                        <div class="xiaoe-plugin-buttons">
                            <button id="xiaoe-detect-duplicates" class="xiaoe-btn xiaoe-btn-primary">
                                检测重复考试
                            </button>
                            <button id="xiaoe-delete-duplicates" class="xiaoe-btn xiaoe-btn-danger" disabled>
                                删除勾选副本
                            </button>
                            <button id="xiaoe-delete-all-duplicates" class="xiaoe-btn xiaoe-btn-danger" disabled>
                                删除全部副本
                            </button>
                        </div>
                        <div id="xiaoe-plugin-status" class="xiaoe-plugin-status">准备就绪</div>
                        <div id="xiaoe-progress" class="xiaoe-progress" style="display:none">
                            <div class="xiaoe-progress-info">
                                <span class="xiaoe-progress-label" id="xiaoe-progress-label"></span>
                                <span id="xiaoe-progress-count"></span>
                            </div>
                            <div class="xiaoe-progress-track">
                                <div class="xiaoe-progress-bar" id="xiaoe-progress-bar"></div>
                            </div>
                        </div>
                        <div id="xiaoe-plugin-results" class="xiaoe-plugin-results"></div>
                    </div>
                </div>
            `;

            // 插入到页面中
            if (toolbar === document.body) {
                toolbar.insertBefore(pluginContainer, toolbar.firstChild);
            } else {
                toolbar.appendChild(pluginContainer);
            }

            // 绑定事件
            document.getElementById('xiaoe-toggle-panel').addEventListener('click', () => this.togglePanel());
            document.getElementById('xiaoe-detect-duplicates').addEventListener('click', () => this.detectDuplicates());
            document.getElementById('xiaoe-delete-duplicates').addEventListener('click', () => this.deleteDuplicates());
            document.getElementById('xiaoe-delete-all-duplicates').addEventListener('click', () => this.deleteDuplicates(true));
            document.getElementById('xiaoe-clear-filter').addEventListener('click', () => this.clearDateFilter());

            // 添加样式
            this.addStyles();
        }

        togglePanel() {
            const content = document.getElementById('xiaoe-plugin-content');
            const btn = document.getElementById('xiaoe-toggle-panel');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                btn.textContent = '−';
            } else {
                content.style.display = 'none';
                btn.textContent = '+';
            }
        }

        addStyles() {
            if (document.querySelector('#xiaoe-plugin-styles')) return;

            const style = document.createElement('style');
            style.id = 'xiaoe-plugin-styles';
            style.textContent = `
                .xiaoe-plugin-wrapper {
                    background: #ffffff;
                    border: 1px solid #e2e8f0;
                    padding: 15px;
                    margin: 15px 0;
                    border-radius: 12px;
                    box-shadow: 0 4px 16px rgba(15, 23, 42, 0.08);
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    position: relative;
                    z-index: 9999;
                }

                .xiaoe-plugin-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }

                .xiaoe-plugin-title {
                    color: #1e293b;
                    font-size: 16px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .xiaoe-toggle-btn {
                    background: #f1f5f9;
                    border: 1px solid #e2e8f0;
                    color: #475569;
                    width: 24px;
                    height: 24px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 16px;
                    line-height: 1;
                }

                .xiaoe-toggle-btn:hover {
                    background: #e2e8f0;
                }

                .xiaoe-plugin-content {
                    display: block;
                }

                .xiaoe-filter-section {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 10px;
                    padding: 10px;
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                }

                .xiaoe-filter-label {
                    color: #475569;
                    font-weight: 500;
                    font-size: 14px;
                }

                .xiaoe-date-input {
                    padding: 6px 10px;
                    border: 1px solid #cbd5e1;
                    border-radius: 6px;
                    background: #ffffff;
                    font-size: 13px;
                    color: #1e293b;
                }

                .xiaoe-date-input:focus {
                    outline: none;
                    border-color: #3b82f6;
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
                }

                .xiaoe-date-separator {
                    color: #94a3b8;
                    font-size: 14px;
                }

                .xiaoe-btn-small {
                    padding: 5px 12px;
                    font-size: 12px;
                    background: #f1f5f9;
                    border: 1px solid #e2e8f0;
                    color: #475569;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .xiaoe-btn-small:hover {
                    background: #e2e8f0;
                }

                .xiaoe-plugin-buttons {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                }

                .xiaoe-btn {
                    padding: 7px 14px;
                    border: 1px solid transparent;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: background 0.15s ease, border-color 0.15s ease;
                    color: #ffffff;
                }

                .xiaoe-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }

                .xiaoe-btn-primary {
                    background: #2563eb;
                }

                .xiaoe-btn-primary:hover:not(:disabled) {
                    background: #1d4ed8;
                }

                .xiaoe-btn-warning {
                    background: #ffffff;
                    border-color: #d97706;
                    color: #b45309;
                }

                .xiaoe-btn-warning:hover:not(:disabled) {
                    background: #fffbeb;
                }

                .xiaoe-btn-danger {
                    background: #dc2626;
                }

                .xiaoe-btn-danger:hover:not(:disabled) {
                    background: #b91c1c;
                }

                .xiaoe-btn-info {
                    background: #ffffff;
                    border-color: #cbd5e1;
                    color: #334155;
                }

                .xiaoe-btn-info:hover:not(:disabled) {
                    background: #f1f5f9;
                    border-color: #94a3b8;
                }

                .xiaoe-btn-secondary {
                    background: #ffffff;
                    border-color: #cbd5e1;
                    color: #64748b;
                }

                .xiaoe-btn-secondary:hover:not(:disabled) {
                    background: #f1f5f9;
                    color: #334155;
                }

                .xiaoe-plugin-status {
                    margin-top: 12px;
                    padding: 8px 12px;
                    border-radius: 8px;
                    font-size: 14px;
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    color: #334155;
                }

                /* 进度条 */
                .xiaoe-progress {
                    margin-top: 10px;
                }

                .xiaoe-progress-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 12px;
                    color: #64748b;
                    margin-bottom: 6px;
                }

                .xiaoe-progress-label {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 70%;
                }

                .xiaoe-progress-track {
                    height: 8px;
                    background: #e2e8f0;
                    border-radius: 999px;
                    overflow: hidden;
                }

                .xiaoe-progress-bar {
                    height: 100%;
                    width: 0%;
                    background: linear-gradient(90deg, #3b82f6, #06b6d4);
                    border-radius: 999px;
                    transition: width 0.25s ease;
                }

                .xiaoe-status-info {
                    background: #eff6ff;
                    color: #1d4ed8;
                    border-color: #bfdbfe;
                }

                .xiaoe-status-success {
                    background: #f0fdf4;
                    color: #15803d;
                    border-color: #bbf7d0;
                }

                .xiaoe-status-warning {
                    background: #fffbeb;
                    color: #b45309;
                    border-color: #fde68a;
                }

                .xiaoe-status-error {
                    background: #fef2f2;
                    color: #b91c1c;
                    border-color: #fecaca;
                }

                .xiaoe-plugin-results {
                    margin-top: 15px;
                    max-height: 500px;
                    overflow-y: auto;
                }

                .xiaoe-result-empty {
                    padding: 20px;
                    text-align: center;
                    color: #16a34a;
                    font-size: 16px;
                    background: #f8fafc;
                    border-radius: 8px;
                }

                .xiaoe-result-header {
                    color: #475569;
                    font-size: 14px;
                    font-weight: 500;
                    margin-bottom: 10px;
                }

                .xiaoe-duplicate-list {
                    background: #ffffff;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    padding: 12px;
                }

                .xiaoe-duplicate-group {
                    margin-bottom: 15px;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    overflow: hidden;
                }

                .xiaoe-duplicate-group:last-child {
                    margin-bottom: 0;
                }

                .xiaoe-group-header {
                    background: #f8fafc;
                    padding: 10px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid #e2e8f0;
                }

                .xiaoe-group-name {
                    font-weight: 600;
                    color: #1e293b;
                    font-size: 14px;
                }

                .xiaoe-group-count {
                    background: #f59e0b;
                    color: white;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 500;
                }

                .xiaoe-group-content {
                    padding: 8px 0;
                }

                .xiaoe-exam-item {
                    display: flex;
                    align-items: center;
                    padding: 8px 12px;
                    gap: 10px;
                    border-bottom: 1px solid #f1f5f9;
                }

                .xiaoe-exam-item:last-child {
                    border-bottom: none;
                }

                .xiaoe-exam-original {
                    background: #f0fdf4;
                }

                .xiaoe-exam-duplicate {
                    background: #fffbeb;
                }

                .xiaoe-badge {
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    min-width: 40px;
                    text-align: center;
                }

                .xiaoe-badge-original {
                    background: #22c55e;
                    color: white;
                }

                .xiaoe-badge-duplicate {
                    background: #f59e0b;
                    color: white;
                }

                .xiaoe-exam-id {
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    color: #64748b;
                    min-width: 80px;
                }

                .xiaoe-exam-name {
                    flex: 1;
                    font-size: 14px;
                    color: #1e293b;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .xiaoe-exam-time {
                    font-size: 12px;
                    color: #94a3b8;
                    min-width: 120px;
                }

                .xiaoe-delete-checkbox {
                    width: 16px;
                    height: 16px;
                    cursor: pointer;
                    accent-color: #3b82f6;
                }

                .xiaoe-exam-info {
                    background: #ffffff;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    padding: 12px;
                }

                .xiaoe-info-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }

                .xiaoe-info-table thead {
                    background: #f8fafc;
                }

                .xiaoe-info-table th {
                    padding: 8px;
                    text-align: left;
                    font-weight: 600;
                    color: #1e293b;
                    border-bottom: 2px solid #e2e8f0;
                }

                .xiaoe-info-table td {
                    padding: 8px;
                    border-bottom: 1px solid #f1f5f9;
                    color: #475569;
                }

                .xiaoe-info-table tbody tr:hover {
                    background: #f8fafc;
                }

                .xiaoe-plugin-results::-webkit-scrollbar {
                    width: 8px;
                }

                .xiaoe-plugin-results::-webkit-scrollbar-track {
                    background: #f1f5f9;
                    border-radius: 4px;
                }

                .xiaoe-plugin-results::-webkit-scrollbar-thumb {
                    background: #cbd5e1;
                    border-radius: 4px;
                }

                .xiaoe-plugin-results::-webkit-scrollbar-thumb:hover {
                    background: #94a3b8;
                }

                /* SweetAlert2弹窗必须高于插件面板(z-index:9999)，否则确认框被压住看不见 */
                .swal2-container { z-index: 20000 !important; }
            `;

            document.head.appendChild(style);
        }

        // 获取考试列表
        async getExamList() {
            this.updateStatus('正在获取考试列表...');

            try {
                console.log('🔍 开始分析页面结构...');

                // 方式1: 尝试从页面中提取考试列表数据 - 针对小鹅通优化
                // 先跳过表头，找数据表格
                const dataTables = document.querySelectorAll('table:not(.ss-table__header)');
                console.log(`📋 找到 ${dataTables.length} 个数据表格`);

                let examTable = null;
                for (let table of dataTables) {
                    const rows = table.querySelectorAll('tr');
                    if (rows.length > 1) { // 至少有表头+数据
                        examTable = table;
                        console.log('📋 选择数据表格:', table.className);
                        break;
                    }
                }

                // 如果没找到，尝试其他选择器
                if (!examTable) {
                    examTable = document.querySelector('.el-table__body-wrapper') ||
                                    document.querySelector('.ant-table-tbody') ||
                                    document.querySelector('tbody') ||
                                    document.querySelector('[class*="table-body"]') ||
                                    document.querySelector('[class*="data-table"]');
                }

                console.log('📋 最终选择的表格元素:', examTable);

                if (examTable) {
                    const rows = examTable.querySelectorAll('tr');
                    console.log(`📊 找到 ${rows.length} 行数据`);

                    this.examList = Array.from(rows).map((row, index) => {
                        const cells = row.querySelectorAll('td');
                        const ths = row.querySelectorAll('th');

                        // 跳过表头行
                        if (ths.length > 0 && cells.length === 0) {
                            console.log(`⏭️ 跳过表头行 ${index}`);
                            return null;
                        }

                        // 尝试多种方式获取考试信息
                        if (cells.length > 0) {
                            // 优先提取resource_id
                            const resourceId = this.extractResourceId(row) || 
                                              row.getAttribute('data-resource-id');
                            
                            // 只保留有有效resource_id的记录（ex_开头）
                            if (!resourceId || !resourceId.startsWith('ex_')) {
                                return null;
                            }
                            
                            // 提取考试名称（第0列）
                            let name = this.getCellText(cells, 0);
                            
                            // 提取创建时间（第3列）
                            const createTime = this.getCellText(cells, 3);
                            
                            // 过滤掉加载失败的名称
                            if (name === '加载失败' || name.includes('加载失败')) {
                                return null;
                            }
                            
                            const exam = {
                                index: index,
                                id: resourceId,
                                name: name,
                                course: '', // 暂时留空，后续从其他方式获取
                                createTime: createTime,
                                resource_id: resourceId
                            };

                            console.log(`📝 第${index}行:`, exam);
                            return exam;
                        }
                        return null;
                    }).filter(exam => exam && exam.name);

                    console.log(`✅ 解析到 ${this.examList.length} 个有效考试`);
                    
                    if (this.examList.length > 0) {
                        this.updateStatus(`获取到 ${this.examList.length} 个考试`);
                        return this.examList;
                    }
                }

                // 方式2: 尝试从Vue实例获取数据
                console.log('🔍 尝试从Vue实例获取数据...');
                const vueData = this.tryGetFromVue();
                if (vueData && vueData.length > 0) {
                    this.examList = vueData;
                    this.updateStatus(`从Vue获取到 ${this.examList.length} 个考试`);
                    return this.examList;
                }

                // 方式3: 尝试从React实例获取数据
                console.log('🔍 尝试从React实例获取数据...');
                const reactData = this.tryGetFromReact();
                if (reactData && reactData.length > 0) {
                    this.examList = reactData;
                    this.updateStatus(`从React获取到 ${this.examList.length} 个考试`);
                    return this.examList;
                }

                // 方式4: 查找所有可能的列表元素
                console.log('🔍 尝试查找所有列表元素...');
                const listData = this.tryFindListElements();
                if (listData && listData.length > 0) {
                    this.examList = listData;
                    this.updateStatus(`从列表元素获取到 ${this.examList.length} 个考试`);
                    return this.examList;
                }

                // 如果都失败了，输出页面结构供调试
                console.log('❌ 所有方式都失败了，输出页面结构供调试:');
                this.debugPageStructure();

                this.updateStatus('无法从页面解析考试列表，请查看控制台', 'warning');
                return [];

            } catch (error) {
                console.error('❌ 获取考试列表异常:', error);
                this.updateStatus('获取考试列表失败: ' + error.message, 'error');
                return [];
            }
        }

        // 尝试从Vue实例获取数据
        tryGetFromVue() {
            try {
                // 查找Vue实例
                const app = document.querySelector('#app');
                if (app && app.__vue__) {
                    console.log('🔍 检测到Vue实例:', app.__vue__);
                    const vueData = this.extractVueData(app.__vue__);
                    if (vueData.length > 0) {
                        return vueData;
                    }
                }

                // 查找其他可能的Vue实例
                const vueElements = document.querySelectorAll('[data-v-*], .vue-component');
                console.log(`🔍 找到 ${vueElements.length} 个可能的Vue元素`);

                for (let element of vueElements) {
                    if (element.__vue__) {
                        console.log('🔍 Vue元素数据:', element.__vue__);
                        const data = this.extractVueData(element.__vue__);
                        if (data.length > 0) {
                            return data;
                        }
                    }
                }

                return [];
            } catch (error) {
                console.log('❌ 从Vue实例获取数据失败:', error);
                return [];
            }
        }

        // 从Vue实例提取数据
        extractVueData(vueInstance) {
            try {
                const data = [];
                console.log('🔍 Vue实例数据结构:', Object.keys(vueInstance.$data || {}));

                // 尝试常见的数据属性名
                const possibleDataKeys = [
                    'examList', 'list', 'tableData', 'dataSource',
                    'exams', 'items', 'rows', 'data'
                ];

                for (let key of possibleDataKeys) {
                    if (vueInstance.$data && vueInstance.$data[key]) {
                        console.log(`✅ 找到数据属性: ${key}`, vueInstance.$data[key]);
                        if (Array.isArray(vueInstance.$data[key])) {
                            return vueInstance.$data[key].map((item, index) => ({
                                index: index,
                                id: item.id || item.resource_id || item.exam_id || '',
                                name: item.name || item.title || item.exam_name || '',
                                createTime: item.createTime || item.created_at || item.create_time || '',
                                resource_id: item.resource_id || item.id || ''
                            }));
                        }
                    }
                }

                // 尝试从computed属性获取
                if (vueInstance.$computed) {
                    console.log('🔍 Computed属性:', Object.keys(vueInstance.$computed));
                }

                return [];
            } catch (error) {
                console.log('❌ 提取Vue数据失败:', error);
                return [];
            }
        }

        // 尝试从React实例获取数据
        tryGetFromReact() {
            try {
                const reactRoot = document.querySelector('#root, #app, [data-reactroot]');
                if (!reactRoot) return [];

                // 查找React Fiber节点
                const fiberKey = Object.keys(reactRoot).find(key =>
                    key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')
                );

                if (fiberKey) {
                    console.log('🔍 检测到React实例');
                    const fiber = reactRoot[fiberKey];
                    return this.extractReactData(fiber);
                }

                return [];
            } catch (error) {
                console.log('❌ 从React实例获取数据失败:', error);
                return [];
            }
        }

        // 从React实例提取数据
        extractReactData(fiber) {
            try {
                const data = [];
                // 这里需要根据实际的React数据结构来调整
                console.log('🔍 React Fiber结构:', fiber);
                return data;
            } catch (error) {
                console.log('❌ 提取React数据失败:', error);
                return [];
            }
        }

        // 尝试查找所有可能的列表元素
        tryFindListElements() {
            try {
                const data = [];

                // 查找所有包含考试相关class的元素
                const examElements = document.querySelectorAll('[class*="exam"], [class*="test"], [class*="question"]');
                console.log(`🔍 找到 ${examElements.length} 个考试相关元素`);

                // 查找所有列表项
                const listItems = document.querySelectorAll('li, [class*="list-item"], [class*="item"]');
                console.log(`🔍 找到 ${listItems.length} 个列表项`);

                // 查找所有卡片元素
                const cards = document.querySelectorAll('[class*="card"], [class*="row"]');
                console.log(`🔍 找到 ${cards.length} 个卡片元素`);

                return data;
            } catch (error) {
                console.log('❌ 查找列表元素失败:', error);
                return [];
            }
        }

        // 分析分页结构
        analyzePagination() {
            const paginationInfo = {
                found: false,
                selectors: [],
                buttons: [],
                currentPage: null,
                totalPages: null,
                hasNext: false,
                hasPrev: false
            };

            // 查找分页容器
            const paginationSelectors = [
                '.pagination',
                '.el-pagination',
                '.ant-pagination',
                '[class*="pagination"]',
                '.ss-pagination'
            ];

            paginationSelectors.forEach(selector => {
                const element = document.querySelector(selector);
                if (element) {
                    paginationInfo.found = true;
                    paginationInfo.selectors.push(selector);
                    console.log(`📄 找到分页容器: ${selector}`, element.className);
                    
                    // 查找所有按钮
                    const buttons = element.querySelectorAll('button, .item, li');
                    buttons.forEach((btn, i) => {
                        const text = btn.textContent.trim();
                        const isDisabled = btn.disabled || btn.classList.contains('disabled');
                        paginationInfo.buttons.push({
                            index: i,
                            text: text,
                            disabled: isDisabled,
                            className: btn.className
                        });
                        console.log(`  按钮 ${i}: "${text}" (disabled: ${isDisabled})`);
                    });
                }
            });

            // 尝试通过文本查找分页信息
            const bodyText = document.body.textContent;
            const pageMatch = bodyText.match(/(\d+)\s*\/\s*(\d+)/);
            if (pageMatch) {
                paginationInfo.currentPage = parseInt(pageMatch[1]);
                paginationInfo.totalPages = parseInt(pageMatch[2]);
                console.log(`📄 页码信息: ${paginationInfo.currentPage} / ${paginationInfo.totalPages}`);
            }

            // 检查是否有下一页（数字分页）
            const currentPageBtn = paginationInfo.buttons.find(btn => 
                btn.className.includes('ss-pagination-item__active')
            );
            
            if (currentPageBtn) {
                const currentPageNum = parseInt(currentPageBtn.text);
                const hasNextPage = paginationInfo.buttons.some(btn => 
                    parseInt(btn.text) === currentPageNum + 1 && !btn.disabled
                );
                paginationInfo.hasNext = hasNextPage;
                
                const hasPrevPage = paginationInfo.buttons.some(btn => 
                    parseInt(btn.text) === currentPageNum - 1 && !btn.disabled
                );
                paginationInfo.hasPrev = hasPrevPage;
            }

            console.log(`📄 分页分析完成: 下一页=${paginationInfo.hasNext}, 上一页=${paginationInfo.hasPrev}`);
            return paginationInfo;
        }

        // 调试页面结构
        debugPageStructure(examList = null, duplicates = null) {
            console.log('🔍 === 页面结构调试信息 ===');

            // 收集调试信息
            const debugInfo = {
                url: window.location.href,
                title: document.title,
                timestamp: new Date().toISOString(),
                containers: {},
                tables: [],
                keywords: {},
                bodySample: document.body.textContent.substring(0, 500),
                allTables: [],
                pagination: this.analyzePagination(),
                examList: examList || [],
                duplicates: duplicates || []
            };

            // 输出主要容器
            const mainContainers = [
                '#app', '#root', '.main', '.content', '.container',
                '[class*="exam"]', '[class*="table"]', '[class*="list"]'
            ];

            mainContainers.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    console.log(`📋 ${selector}: 找到 ${elements.length} 个元素`);
                    debugInfo.containers[selector] = elements.length;
                    elements.forEach((el, i) => {
                        console.log(`  ${i + 1}.`, el.className, el.id);
                    });
                }
            });

            // 输出所有表格
            const tables = document.querySelectorAll('table');
            console.log(`📊 表格数量: ${tables.length}`);
            debugInfo.tables.total = tables.length;

            tables.forEach((table, i) => {
                console.log(`表格 ${i + 1}:`, table.className);
                const rows = table.querySelectorAll('tr');
                console.log(`  行数: ${rows.length}`);
                
                const tableInfo = {
                    index: i + 1,
                    className: table.className,
                    rowCount: rows.length,
                    isHeader: table.classList.contains('ss-table__header')
                };

                if (rows.length > 0) {
                    const firstRow = rows[0];
                    const cells = firstRow.querySelectorAll('td, th');
                    console.log(`  列数: ${cells.length}`);
                    tableInfo.colCount = cells.length;

                    const headers = [];
                    const cellContents = [];
                    cells.forEach((cell, j) => {
                        const text = cell.textContent.trim().substring(0, 30);
                        console.log(`    列${j + 1}: ${text}`);
                        headers.push(text);
                        cellContents.push(text);
                    });
                    tableInfo.headers = headers;
                    tableInfo.cellContents = cellContents;
                }

                debugInfo.tables.details = debugInfo.tables.details || [];
                debugInfo.tables.details.push(tableInfo);
                
                // 收集所有表格信息
                debugInfo.allTables.push(tableInfo);
            });

            // 输出页面主要文本内容
            const bodyText = document.body.textContent;
            const keywords = ['考试', '试题', '试卷', '题目', 'exam', 'test'];
            keywords.forEach(keyword => {
                const regex = new RegExp(keyword, 'gi');
                const matches = bodyText.match(regex);
                if (matches) {
                    console.log(`🔍 关键词 "${keyword}": 出现 ${matches.length} 次`);
                    debugInfo.keywords[keyword] = matches.length;
                }
            });

            console.log('🔍 === 调试信息结束 ===');

            // 生成可复制的调试信息
            const debugString = JSON.stringify(debugInfo, null, 2);
            console.log('📋 调试信息(JSON格式):');
            console.log(debugString);

            // 自动尝试多种方式传递调试信息
            this.autoSendDebugInfo(debugInfo, debugString);
        }

        // 自动发送调试信息
        autoSendDebugInfo(debugInfo, debugString) {
            // 方式1: 尝试POST到本地服务器
            this.trySendToLocalServer(debugInfo);

            // 方式2: 保存到localStorage
            try {
                localStorage.setItem('xiaoe_debug_info', debugString);
                localStorage.setItem('xiaoe_debug_timestamp', Date.now().toString());
                console.log('✅ 调试信息已保存到 localStorage');
            } catch (error) {
                console.log('⚠️ 保存到localStorage失败:', error);
            }

            // 方式3: 创建下载文件
            this.createDebugDownload(debugString);

            // 方式4: 尝试剪贴板
            this.tryCopyToClipboard(debugString);

            // 方式5: 显示弹窗
            this.showDebugPopup(debugString, debugInfo);
        }

        // 尝试发送到本地服务器
        trySendToLocalServer(debugInfo) {
            const localServers = [
                'http://127.0.0.1:5031/api/debug',
                'http://localhost:5030/api/debug',
                'http://127.0.0.1:3000/debug',
                'http://localhost:3000/debug'
            ];

            localServers.forEach(serverUrl => {
                fetch(serverUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        type: 'xiaoe_debug',
                        data: debugInfo,
                        timestamp: Date.now()
                    })
                }).then(response => {
                    console.log(`✅ 调试信息已发送到 ${serverUrl}`);
                    this.updateStatus(`调试信息已发送到本地服务器`, 'success');
                }).catch(error => {
                    console.log(`⚠️ 发送到 ${serverUrl} 失败:`, error.message);
                });
            });
        }

        // 创建调试信息下载文件
        createDebugDownload(debugString) {
            try {
                const blob = new Blob([debugString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `xiaoe_debug_${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                console.log('✅ 调试信息已下载为JSON文件');
            } catch (error) {
                console.log('⚠️ 创建下载文件失败:', error);
            }
        }

        // 尝试复制到剪贴板
        tryCopyToClipboard(debugString) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(debugString).then(() => {
                    console.log('✅ 调试信息已复制到剪贴板');
                    this.updateStatus('调试信息已复制到剪贴板', 'success');
                }).catch(() => {
                    console.log('⚠️ 自动复制失败');
                });
            } else {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = debugString;
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    console.log('✅ 调试信息已复制到剪贴板(降级方案)');
                } catch (error) {
                    console.log('⚠️ 降级复制也失败');
                }
                document.body.removeChild(textarea);
            }
        }

        // 自动发送调试信息到本地服务器
        async sendDebugToServer(debugData) {
            const SERVER_URL = 'http://127.0.0.1:5031/api/debug';
            
            try {
                console.log('📡 正在发送调试信息到本地服务器...');
                
                const response = await fetch(SERVER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(debugData)
                });
                
                if (response.ok) {
                    const result = await response.json();
                    console.log('✅ 调试信息已发送到本地服务器:', result);
                    return true;
                } else {
                    console.log('⚠️ 服务器响应错误:', response.status);
                    return false;
                }
            } catch (error) {
                console.log('❌ 发送到本地服务器失败:', error.message);
                console.log('💡 提示：请先启动调试服务器: node debug-server.js');
                console.log('💡 服务器应该在端口 5031 上运行');
                return false;
            }
        }

        // 显示调试信息弹窗
        showDebugPopup(debugString, debugData) {
            // 先尝试自动发送到服务器
            this.sendDebugToServer(debugData);
            
            // 创建弹窗显示调试信息
            const popup = document.createElement('div');
            popup.id = 'xiaoe-debug-popup';
            popup.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                z-index: 2147483647;
                max-width: 90%;
                max-height: 90%;
                overflow: auto;
                font-family: monospace;
                font-size: 12px;
                border: 2px solid #007bff;
            `;

            popup.innerHTML = `
                <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                    <strong style="font-size: 16px;">🔍 调试信息</strong>
                    <button id="xiaoe-close-popup" style="padding: 5px 10px; cursor: pointer; background: #dc3545; color: white; border: none; border-radius: 4px;">关闭</button>
                </div>
                <div style="margin-bottom: 10px; font-size: 12px; color: #28a745;">
                    ✅ 已自动发送到本地服务器 (http://127.0.0.1:5031)
                </div>
                <textarea id="xiaoe-debug-text" style="width: 100%; height: 400px; font-family: monospace; font-size: 11px; padding: 10px; border: 1px solid #ccc; border-radius: 4px;">${debugString}</textarea>
                <div style="margin-top: 15px; display: flex; gap: 10px;">
                    <button id="xiaoe-copy-btn" style="padding: 10px 20px; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; font-size: 14px;">📋 复制到剪贴板</button>
                    <button id="xiaoe-download-btn" style="padding: 10px 20px; cursor: pointer; background: #28a745; color: white; border: none; border-radius: 4px; font-size: 14px;">💾 下载文件</button>
                </div>
                <div style="margin-top: 10px; font-size: 11px; color: #666;">
                    💡 如果自动发送失败，请手动复制内容
                </div>
            `;

            document.body.appendChild(popup);
            console.log('✅ 调试信息弹窗已显示');

            // 绑定按钮事件
            setTimeout(() => {
                const closeBtn = document.getElementById('xiaoe-close-popup');
                const copyBtn = document.getElementById('xiaoe-copy-btn');
                const downloadBtn = document.getElementById('xiaoe-download-btn');
                const debugText = document.getElementById('xiaoe-debug-text');

                if (closeBtn) {
                    closeBtn.onclick = () => {
                        popup.remove();
                    };
                }

                if (copyBtn) {
                    copyBtn.onclick = () => {
                        if (debugText) {
                            navigator.clipboard.writeText(debugText.value).then(() => {
                                alert('✅ 已复制到剪贴板！');
                            }).catch(() => {
                                debugText.select();
                                document.execCommand('copy');
                                alert('✅ 已复制到剪贴板！');
                            });
                        }
                    };
                }

                if (downloadBtn) {
                    downloadBtn.onclick = () => {
                        if (debugText) {
                            const blob = new Blob([debugText.value], {type: 'application/json'});
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'xiaoe_debug_' + Date.now() + '.json';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            alert('✅ 文件已下载！');
                        }
                    };
                }
            }, 100);
        }

        // 获取单元格文本的辅助方法
        getCellText(cells, index) {
            if (!cells || !cells[index]) return '';
            let text = cells[index].textContent?.trim() || '';
            
            // 只过滤按钮文字，保留考试名称中的正常内容
            const unwantedTexts = [
                '更换封面', '取消确认', '查看审核记录', '批阅列表', '管理', '分享', 
                '更多', '老师管理', '设置证书', '设置', '¥199', '¥'
            ];
            
            // 移除按钮文字
            unwantedTexts.forEach(unwanted => {
                text = text.replace(new RegExp(unwanted, 'g'), '');
            });
            
            // 清理多余空格
            text = text.replace(/\s+/g, ' ').trim();
            
            return text;
        }

        // 从页面元素提取 resource_id
        extractResourceId(row) {
            const link = row.querySelector('a[href*="resource_id"]');
            if (link) {
                const match = link.href.match(/resource_id=([^&]+)/);
                return match ? match[1] : null;
            }

            const resourceId = row.getAttribute('data-resource-id');
            if (resourceId) return resourceId;

            const clickHandler = row.getAttribute('onclick');
            if (clickHandler) {
                const match = clickHandler.match(/resource_id["\s:]+([^",\s]+)/);
                return match ? match[1] : null;
            }

            return null;
        }

        // 清除日期筛选
        clearDateFilter() {
            document.getElementById('xiaoe-start-date').value = '';
            document.getElementById('xiaoe-end-date').value = '';
            this.updateStatus('已清除日期筛选', 'success');
        }

        // 获取日期筛选条件
        getDateFilter() {
            const startDateInput = document.getElementById('xiaoe-start-date');
            const endDateInput = document.getElementById('xiaoe-end-date');
            
            const startDate = startDateInput ? startDateInput.value : '';
            const endDate = endDateInput ? endDateInput.value : '';
            
            console.log('📅 日期输入值:', { startDate, endDate });
            
            return {
                startDate: startDate ? new Date(startDate) : null,
                endDate: endDate ? new Date(endDate) : null
            };
        }

        // 检查考试是否在日期范围内
        isExamInDateRange(exam, dateFilter) {
            // 如果没有设置日期筛选，返回true（包含所有）
            if (!dateFilter.startDate && !dateFilter.endDate) {
                return true;
            }

            // 尝试解析考试日期
            const examDate = this.parseExamDate(exam.createTime);
            if (!examDate) {
                // 如果日期无效，直接包含（避免误删有效考试）
                return true;
            }

            // 检查是否在日期范围内
            if (dateFilter.startDate && examDate < dateFilter.startDate) {
                return false;
            }

            if (dateFilter.endDate && examDate > dateFilter.endDate) {
                return false;
            }

            return true;
        }

        // 解析考试日期
        parseExamDate(dateStr) {
            if (!dateStr) return null;
            
            // 如果是"目录"等无效值，返回null
            if (dateStr === '目录' || dateStr === '加载失败' || dateStr.length < 10) {
                return null;
            }

            // 尝试解析日期格式
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) {
                return null;
            }

            return date;
        }

        // 检测重复考试
        async detectDuplicates() {
            this.updateStatus('正在检测重复考试...');

            // === 路径1: 用捕获到的真实API签名重放请求，拉全量数据 ===
            const examListSig = this.examListApiSignature || this.getBuiltinSignatures().examList;
            if (examListSig) {
                console.log('🎯 使用考试列表API拉取全量数据:', examListSig.url);
                this.updateStatus('通过API拉取考试数据...');
                try {
                    const items = await this.fetchAllExamsViaApi(examListSig);
                    if (items.length > 0) {
                        this.examList = items.map((e, i) => this.normalizeApiExam(e, i));
                        console.log(`✅ API共拉取 ${this.examList.length} 个考试`);

                        const dateFilter = this.getDateFilter();
                        if (dateFilter.startDate || dateFilter.endDate) {
                            this.examList = this.examList.filter(exam => this.isExamInDateRange(exam, dateFilter));
                            console.log(`📊 日期筛选后剩余 ${this.examList.length} 个考试`);
                        }

                        await this.analyzeDuplicates();
                        return;
                    }
                    console.log('⚠️ API拉取返回空，检查是否是列表接口');
                } catch (e) {
                    console.error('❌ API拉取失败:', e);
                    this.updateStatus('API拉取失败: ' + e.message, 'error');
                }
            }

            // === 路径2: 还没捕获到签名 → 在已捕获请求里找候选 ===
            if (!this.examListApiSignature && this.capturedRequests.length > 0) {
                console.log(`🔍 在 ${this.capturedRequests.length} 个已捕获请求中寻找考试列表接口...`);
                let scanCount = 0;
                for (const req of this.capturedRequests) {
                    // 先文本预筛，不含 ex_ 的响应直接跳过，避免大量JSON.parse卡死
                    if (!req.response || !req.response.includes('ex_')) continue;
                    if (++scanCount % 10 === 0) await this.sleep(0); // 让出主线程
                    try {
                        const data = JSON.parse(req.response);
                        const items = this.extractExamArray(data);
                        if (items.length > 0 && items.some(it => String(it.id || it.resource_id || '').startsWith('ex_'))) {
                            this.examListApiSignature = { url: req.url, method: req.method, body: req.body, sample: data };
                            console.log('🎯 候选考试列表API:', req.url);
                            break;
                        }
                    } catch (e) {}
                }
                if (this.examListApiSignature) {
                    return this.detectDuplicates(); // 用新签名重新走路径1
                }
            }

            // === 路径3: 完全没捕获到 → 提示用户触发一次列表请求 ===
            if (!this.examListApiSignature) {
                console.log('⚠️ 尚未捕获到考试列表API请求');
                console.log('💡 请手动点一次列表上的"下一页"或刷新页面，让页面发出API请求');
                this.updateStatus('未捕获到API请求。请刷新页面，或点一次列表翻页后重试', 'warning');
                // 等待最多15秒看是否有新捕获
                for (let i = 0; i < 30; i++) {
                    await this.sleep(500);
                    if (this.examListApiSignature) {
                        console.log('✅ 等待期间捕获到了API，继续');
                        return this.detectDuplicates();
                    }
                }
                // 超时后仍没有 → 询问是否用DOM兜底
                const useDom = typeof Swal !== 'undefined'
                    ? (await Swal.fire({
                        title: '未捕获到API',
                        text: '无法通过API获取数据。是否使用DOM翻页兜底（较慢，251页约需几分钟）？',
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: '用DOM兜底',
                        cancelButtonText: '取消'
                    })).isConfirmed
                    : confirm('未捕获到API。是否使用DOM翻页兜底（较慢）？');
                if (!useDom) {
                    this.updateStatus('已取消。刷新页面后重试', 'warning');
                    return;
                }
            }

            // === 路径4: DOM兜底（仅在用户确认后）===
            console.log('📄 使用DOM解析方式获取考试列表（兜底）...');
            
            // 先分析分页结构
            const paginationInfo = this.analyzePagination();
            console.log('📄 分页信息:', paginationInfo);
            
            // 累积所有页面的考试数据
            this.allExamList = [];
            let currentPage = 1;
            let maxPages = paginationInfo.totalPages || 300; // 最多300页，防止无限循环
            let hasMorePages = true;
            
            // 获取日期筛选条件
            const dateFilter = this.getDateFilter();
            if (dateFilter.startDate || dateFilter.endDate) {
                console.log('📅 日期筛选:', dateFilter);
                this.updateStatus(`日期筛选: ${dateFilter.startDate?.toLocaleDateString()} 至 ${dateFilter.endDate?.toLocaleDateString()}`);
            }
            
            // 如果当前不在第1页，先跳到第1页
            const currentActivePage = paginationInfo.buttons.find(btn => 
                btn.className.includes('ss-pagination-item__active')
            );
            if (currentActivePage && parseInt(currentActivePage.text) !== 1) {
                console.log('📄 当前不在第1页，跳转到第1页');
                const firstPageBtn = paginationInfo.buttons.find(btn => parseInt(btn.text) === 1);
                if (firstPageBtn) {
                    const paginationElement = document.querySelector('.ss-pagination');
                    if (paginationElement) {
                        const buttons = paginationElement.querySelectorAll('.ss-pagination-item');
                        const targetButton = buttons[firstPageBtn.index];
                        if (targetButton) {
                            targetButton.click();
                            await this.sleep(2000);
                        }
                    }
                }
            }
            
            while (hasMorePages && currentPage <= maxPages) {
                this.updateStatus(`正在收集第 ${currentPage} 页数据...`);
                const pageExams = await this.getExamList();
                
                if (pageExams.length > 0) {
                    // 应用日期筛选
                    const filteredExams = pageExams.filter(exam => 
                        this.isExamInDateRange(exam, dateFilter)
                    );
                    
                    this.allExamList.push(...filteredExams);
                    console.log(`✅ 第 ${currentPage} 页收集到 ${pageExams.length} 个考试，筛选后 ${filteredExams.length} 个`);
                } else {
                    console.log(`⚠️ 第 ${currentPage} 页没有考试数据`);
                }
                
                // 尝试翻到下一页
                hasMorePages = await this.goToNextPage();
                if (hasMorePages) {
                    currentPage++;
                    // 等待页面加载
                    await this.sleep(2000);
                }
            }
            
            this.examList = this.allExamList;

            if (this.examList.length === 0) {
                this.updateStatus('没有找到考试数据', 'error');
                return;
            }

            console.log(`📊 总共收集到 ${this.examList.length} 个考试`);
            this.updateStatus(`收集到 ${this.examList.length} 个考试，正在分析...`);

            await this.analyzeDuplicates();
        }

        // 分析重复考试
        async analyzeDuplicates() {
            if (this.examList.length === 0) {
                this.updateStatus('没有找到考试数据', 'error');
                return;
            }

            console.log(`📊 分析 ${this.examList.length} 个考试...`);

            // 按考试名称分组
            const nameGroups = new Map();
            this.examList.forEach(exam => {
                const normalizedName = this.normalizeExamName(exam.name);
                if (!nameGroups.has(normalizedName)) {
                    nameGroups.set(normalizedName, []);
                }
                nameGroups.get(normalizedName).push(exam);
            });

            // 找出重复的考试
            this.duplicateGroups = [];
            nameGroups.forEach((exams, name) => {
                if (exams.length > 1) {
                    exams.sort((a, b) => {
                        const timeA = new Date(a.createTime || 0);
                        const timeB = new Date(b.createTime || 0);
                        return timeA - timeB;
                    });

                    this.duplicateGroups.push({
                        name: name,
                        original: exams[0],
                        duplicates: exams.slice(1)
                    });
                    this.originalExams.set(name, exams[0]);
                }
            });

            this.displayDuplicateResults();

            // 轻量上报：只发统计摘要，不再 dump 全量数据（全量会卡死页面）
            this.sendDebugToServer({
                type: 'duplicate_summary',
                total: this.examList.length,
                groups: this.duplicateGroups.length,
                topGroups: this.duplicateGroups.slice(0, 20).map(g => ({ name: g.name, count: g.duplicates.length }))
            });

            if (this.duplicateGroups.length > 0) {
                document.getElementById('xiaoe-delete-duplicates').disabled = false;
                document.getElementById('xiaoe-delete-all-duplicates').disabled = false;
                this.updateStatus(`检测完成，发现 ${this.duplicateGroups.length} 组重复考试`, 'success');
            } else {
                this.updateStatus('未发现重复考试', 'success');
            }
        }

        // 翻到下一页
        async goToNextPage() {
            // 先重新分析分页结构
            const paginationInfo = this.analyzePagination();
            
            // 找到当前页码
            const currentPageBtn = paginationInfo.buttons.find(btn => 
                btn.className.includes('ss-pagination-item__active')
            );
            
            if (!currentPageBtn) {
                console.log('📄 找不到当前页码，结束翻页');
                return false;
            }
            
            const currentPageNum = parseInt(currentPageBtn.text);
            const nextPageNum = currentPageNum + 1;
            
            console.log(`📄 当前页: ${currentPageNum}, 准备翻到第 ${nextPageNum} 页`);
            
            // 查找下一页的数字按钮
            const nextPageBtn = paginationInfo.buttons.find(btn => 
                parseInt(btn.text) === nextPageNum && !btn.disabled
            );
            
            if (nextPageBtn) {
                console.log('📄 找到下一页按钮，点击翻页');
                const paginationElement = document.querySelector('.ss-pagination');
                if (paginationElement) {
                    const buttons = paginationElement.querySelectorAll('.ss-pagination-item');
                    const targetButton = buttons[nextPageBtn.index];
                    if (targetButton) {
                        targetButton.click();
                        return true;
                    }
                }
            } else {
                console.log(`📄 没有找到第 ${nextPageNum} 页按钮，可能是最后一页`);
            }
            
            return false;
        }

        // 等待函数
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // 标准化考试名称用于比较
        normalizeExamName(name) {
            if (!name) return '';
            return name.trim()
                .replace(/\s+/g, '')
                .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        }

        // 显示重复检测结果
        displayDuplicateResults() {
            const resultsDiv = document.getElementById('xiaoe-plugin-results');

            if (this.duplicateGroups.length === 0) {
                resultsDiv.innerHTML = '<div class="xiaoe-result-empty">🎉 未发现重复考试</div>';
                return;
            }

            // 限制渲染数量，避免几千个DOM节点卡死页面
            const MAX_RENDER = 100;
            const groupsToRender = this.duplicateGroups.slice(0, MAX_RENDER);
            const hiddenCount = this.duplicateGroups.length - groupsToRender.length;

            let html = '<div class="xiaoe-duplicate-list">';
            html += `<div class="xiaoe-result-header">发现 ${this.duplicateGroups.length} 组重复考试${hiddenCount > 0 ? `（仅显示前${MAX_RENDER}组，其余在控制台）` : ''}：</div>`;

            groupsToRender.forEach((group, index) => {
                html += `
                    <div class="xiaoe-duplicate-group">
                        <div class="xiaoe-group-header">
                            <span class="xiaoe-group-name">${group.name}</span>
                            <span class="xiaoe-group-count">${group.duplicates.length + 1} 个副本</span>
                        </div>
                        <div class="xiaoe-group-content">
                            <div class="xiaoe-exam-item xiaoe-exam-original">
                                <span class="xiaoe-badge xiaoe-badge-original">原始</span>
                                <span class="xiaoe-exam-id">${group.original.id}</span>
                                <span class="xiaoe-exam-name">${group.original.name}</span>
                                <span class="xiaoe-exam-time">${group.original.createTime}</span>
                            </div>
                            ${group.duplicates.map(dup => `
                                <div class="xiaoe-exam-item xiaoe-exam-duplicate">
                                    <span class="xiaoe-badge xiaoe-badge-duplicate">副本</span>
                                    <span class="xiaoe-exam-id">${dup.id}</span>
                                    <span class="xiaoe-exam-name">${dup.name}</span>
                                    <span class="xiaoe-exam-time">${dup.createTime}</span>
                                    <input type="checkbox" class="xiaoe-delete-checkbox" data-exam-id="${dup.id}" data-resource-id="${dup.resource_id}" checked>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });

            html += '</div>';
            resultsDiv.innerHTML = html;
        }

        // 显示详细重复信息
        showDuplicateDetails() {
            if (this.duplicateGroups.length === 0) {
                this.updateStatus('请先检测重复考试', 'warning');
                return;
            }

            console.log('\n📋 重复考试详细信息：\n');
            console.table(this.duplicateGroups.map((group, index) => ({
                '组号': index + 1,
                '考试名称': group.name,
                '原始ID': group.original.id,
                '原始名称': group.original.name,
                '副本数量': group.duplicates.length,
                '副本ID列表': group.duplicates.map(d => d.id).join(', ')
            })));

            this.updateStatus('详细信息已输出到控制台', 'success');
        }

        // 批量替换关联
        async replaceAssociations() {
            if (this.duplicateGroups.length === 0) {
                this.updateStatus('请先检测重复考试', 'warning');
                return;
            }

            // 使用SweetAlert2进行确认
            const result = await Swal.fire({
                title: '确认批量替换关联？',
                text: `即将替换 ${this.duplicateGroups.reduce((sum, group) => sum + group.duplicates.length, 0)} 个考试的关联`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '确认替换',
                cancelButtonText: '取消',
                confirmButtonColor: '#ff9800'
            });

            if (!result.isConfirmed) {
                this.updateStatus('已取消替换操作', 'info');
                return;
            }

            this.updateStatus('正在批量替换考试关联...');

            let successCount = 0;
            let failCount = 0;

            for (const group of this.duplicateGroups) {
                for (const duplicate of group.duplicates) {
                    try {
                        console.log(`🔄 替换: ${duplicate.name} -> ${group.original.name}`);
                        const result = await this.replaceExamAssociation(duplicate.resource_id, group.original.resource_id);

                        if (result) {
                            successCount++;
                            console.log(`✅ 替换成功: ${duplicate.name}`);
                        } else {
                            failCount++;
                            console.log(`❌ 替换失败: ${duplicate.name}`);
                        }
                    } catch (error) {
                        console.error(`❌ 替换异常: ${duplicate.name}`, error);
                        failCount++;
                    }
                }
            }

            this.updateStatus(`替换完成：成功 ${successCount} 个，失败 ${failCount} 个`, successCount > 0 ? 'success' : 'error');
        }

        // 替换单个考试的关联
        async replaceExamAssociation(duplicateId, originalId) {
            console.log(`📝 API调用: 替换关联 ${duplicateId} -> ${originalId}`);
            console.log('⚠️ 此功能需要根据实际API接口实现');
            return false; // 需要实现具体API调用
        }

        // 批量删除副本；deleteAll=true时直接走duplicateGroups数据，不受页面只渲染前100组的限制
        async deleteDuplicates(deleteAll = false) {
            if (this.duplicateGroups.length === 0) {
                this.updateStatus('请先检测重复考试', 'warning');
                return;
            }

            let examsToDelete;
            if (deleteAll) {
                examsToDelete = this.duplicateGroups.flatMap(g => g.duplicates.map(d => ({
                    id: d.id,
                    name: d.name,
                    resource_id: d.resource_id
                })));
            } else {
                const checkboxes = document.querySelectorAll('.xiaoe-delete-checkbox:checked');
                examsToDelete = Array.from(checkboxes).map(cb => ({
                    id: cb.dataset.examId,
                    name: cb.closest('.xiaoe-exam-item').querySelector('.xiaoe-exam-name').textContent,
                    resource_id: cb.dataset.resourceId
                }));
            }

            if (examsToDelete.length === 0) {
                this.updateStatus('没有选择要删除的考试', 'warning');
                return;
            }

            // 使用SweetAlert2进行确认（Swal不可用时用prompt兜底）
            let confirmed = false;
            if (typeof Swal !== 'undefined') {
                const result = await Swal.fire({
                    title: '确认批量删除？',
                    html: `即将删除 <strong>${examsToDelete.length}</strong> 个考试副本${deleteAll ? '（跨全部重复组）' : ''}<br><br><small>此操作不可恢复！</small>`,
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonText: '确认删除',
                    cancelButtonText: '取消',
                    confirmButtonColor: '#f44336',
                    input: 'text',
                    inputPlaceholder: '请输入 DELETE 确认',
                    inputValidator: (value) => {
                        if (value !== 'DELETE') {
                            return '请输入 DELETE 确认删除操作';
                        }
                    }
                });
                confirmed = result.isConfirmed;
            } else {
                confirmed = prompt(`将删除 ${examsToDelete.length} 个考试副本，输入 DELETE 确认：`) === 'DELETE';
            }

            if (!confirmed) {
                this.updateStatus('已取消删除操作', 'info');
                return;
            }

            this.updateStatus(`正在删除 ${examsToDelete.length} 个考试副本...`);
            this.updateProgress(0, examsToDelete.length, '准备删除');

            let successCount = 0;
            let failCount = 0;

            for (const exam of examsToDelete) {
                try {
                    this.updateProgress(successCount + failCount, examsToDelete.length, `正在删除：${exam.name}`);
                    console.log(`🗑️ 删除: ${exam.name}`);
                    // resource_id可能是所属课包的course_xxx，删除必须用考试自己的ex_xxx
                    const targetId = [exam.id, exam.resource_id].find(v => /^ex_/.test(String(v))) || exam.id;
                    const result = await this.deleteExam(targetId);

                    if (result) {
                        successCount++;
                        console.log(`✅ 删除成功: ${exam.name}`);
                    } else {
                        failCount++;
                        console.log(`❌ 删除失败: ${exam.name}`);
                        // 显示最近一次失败原因，便于排查
                        if (this.lastDeleteError) this.updateStatus(`删除中 ${successCount+failCount}/${examsToDelete.length}，最近失败: ${this.lastDeleteError}`, 'warning');
                    }
                } catch (error) {
                    console.error(`❌ 删除异常: ${exam.name}`, error);
                    failCount++;
                }
                this.updateProgress(successCount + failCount, examsToDelete.length, exam.name);
                await this.sleep(300); // 限速，防止被风控
            }

            this.updateProgress(examsToDelete.length, examsToDelete.length, '完成');
            let doneMsg = `删除完成：成功 ${successCount} 个，失败 ${failCount} 个`;
            // 大量"non-object"错误=考试仍绑定课包，引导用户走课包流程
            if (failCount > 0 && /non-object/i.test(this.lastDeleteError || '')) {
                doneMsg += '（失败原因疑似考试仍绑定课包，建议用「分析课包→删课包」流程）';
            }
            this.updateStatus(doneMsg, successCount > 0 ? 'success' : 'error');
            setTimeout(() => this.hideProgress(), 3000);

            // 刷新页面
            setTimeout(() => {
                Swal.fire({
                    title: '操作完成',
                    text: `成功删除 ${successCount} 个考试，即将刷新页面...`,
                    icon: 'success',
                    timer: 2000,
                    showConfirmButton: false
                }).then(() => {
                    location.reload();
                });
            }, 1000);
        }

        // 删除单个考试：优先捕获签名，否则用内置 change_exam_status?state=2
        async deleteExam(examId) {
            if (!/^ex_/.test(String(examId))) {
                this.lastDeleteError = `非法考试ID: ${examId}`;
                console.warn(`⚠️ 跳过删除，ID不是ex_开头: ${examId}`);
                return false;
            }
            let sig = this.findCapturedApi(/delet|remove|recycle|change_exam_status|change.*status/i, /ex_/, /state=["']?2|"state":2/)
                   || this.findCapturedApi(/delet|remove|recycle|change_exam_status|change.*status/i, /ex_/)
                   || this.getBuiltinSignatures().examDelete;
            try {
                const r = await this.replayWriteApi(sig, examId);
                const ok = r && r.code === 0;
                if (!ok) {
                    this.lastDeleteError = `code=${r && r.code} msg=${(r && (r.msg || r.message)) || (r && r.raw ? String(r.raw).slice(0,200) : '无响应')}`;
                    console.warn(`⚠️ 删除返回非0: examId=${examId}`, this.lastDeleteError);
                }
                return ok;
            } catch (error) {
                this.lastDeleteError = error.message;
                console.error('❌ 删除考试API调用失败:', error);
                return false;
            }
        }

        // 在捕获的请求里按URL正则+内容正则找接口签名，extraPattern可选进一步加强
        findCapturedApi(urlPattern, contentPattern, extraPattern = null) {
            for (const req of this.capturedRequests) {
                if (urlPattern.test(req.url) && contentPattern.test(req.body + req.response)) {
                    if (extraPattern && !extraPattern.test(req.body)) continue;
                    return req;
                }
            }
            return null;
        }

        // 显示考试信息
        async showExamInfo() {
            this.updateStatus('正在获取考试信息...');
            this.examList = await this.getExamList();

            if (this.examList.length === 0) {
                this.updateStatus('没有找到考试数据', 'error');
                return;
            }

            console.log(`\n📋 当前考试列表 (${this.examList.length} 个)：\n`);
            console.table(this.examList.map(exam => ({
                'ID': exam.id || exam.resource_id || '-',
                '名称': exam.name || '-',
                '创建时间': exam.createTime || '-'
            })));

            this.updateStatus('考试信息已输出到控制台', 'success');
        }

        // 更新状态显示
        updateStatus(message, type = 'info') {
            const statusDiv = document.getElementById('xiaoe-plugin-status');
            if (!statusDiv) {
                console.log(`📋 [状态] ${message}`);
                return;
            }
            statusDiv.textContent = message;
            statusDiv.className = `xiaoe-plugin-status xiaoe-status-${type}`;
        }

        // 进度条：current/total 显示百分比，label 显示当前处理项
        updateProgress(current, total, label = '') {
            const wrap = document.getElementById('xiaoe-progress');
            if (!wrap) return;
            wrap.style.display = 'block';
            const pct = total > 0 ? Math.min(100, Math.round(current / total * 100)) : 0;
            document.getElementById('xiaoe-progress-bar').style.width = `${pct}%`;
            document.getElementById('xiaoe-progress-label').textContent = label;
            document.getElementById('xiaoe-progress-count').textContent = total > 0 ? `${current}/${total} (${pct}%)` : `${current}`;
        }

        hideProgress() {
            const wrap = document.getElementById('xiaoe-progress');
            if (wrap) wrap.style.display = 'none';
        }
    }

    // 初始化插件：document-start 时立即执行，
    // 必须抢在页面JS发出API请求之前注入hook
    new XiaoeExamManager();

})();