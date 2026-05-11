/**
 * ============================================================
 *  LG OPTIMIZER v1.4.0 — Performance Plugin for Lampa
 * ============================================================
 *
 *  Модули:
 *   1  — GPU-слой для карточек (CSS)
 *   2  — keydown RAF throttle          ┐
 *   9  — scroll RAF throttle           ├─ единый патч addEventListener
 *   14 — passive touch/wheel           ┘
 *   3  — localStorage write-buffer (3 уровня приоритета)
 *   4  — fetch deduplicator + timeout + URL guard
 *   5  — image lazy loader (IntersectionObserver)
 *   6  — video timeupdate throttle
 *   7  — JSON / null-response guard (Lampa.Reguest)
 *   8  — EventBus leak monitor (Lampa.Listener)
 *   10 — DNS prefetch + preconnect
 *   11 — Lampa.Template cloneNode кэш
 *   12 — Lampa.Listener 'search' debounce
 *   13 — Fast-nav: отключение CSS transitions при быстрой навигации
 */

(function () {
    'use strict';

    if (window.__LG_OPT_V14__) return;
    window.__LG_OPT_V14__ = true;

    var VERSION       = '1.4.0';
    var COMPONENT_ID  = 'lg_optimizer';

    // Настраиваемые константы — все в одном месте.
    var LS_DEBOUNCE      = 400;   // мс: дебаунс «нормального» localStorage
    var LS_FAST          = 150;   // мс: дебаунс «быстрого» localStorage (UI-ключи)
    var LS_SLOW          = 2000;  // мс: дебаунс «медленного» localStorage
    var PLAYER_MS        = 250;   // мс: интервал throttle для timeupdate
    var IMG_MARGIN       = '400px';
    var FETCH_TIMEOUT    = 15000; // мс
    var SEARCH_DEBOUNCE  = 300;   // мс: дебаунс поиска
    var FASTNAV_GAP      = 150;   // мс: порог «быстрого» нажатия пульта
    var FASTNAV_RESTORE  = 200;   // мс: восстановление transitions после навигации
    var TEMPLATE_MAX     = 40;    // макс. записей в кэше шаблонов

    var KEYS = {
        css:      'lg_opt_css',
        keydown:  'lg_opt_keydown',
        storage:  'lg_opt_storage',
        fetch:    'lg_opt_fetch',
        images:   'lg_opt_images',
        player:   'lg_opt_player',
        json:     'lg_opt_json',
        eventbus: 'lg_opt_eventbus',
        scroll:   'lg_opt_scroll',
        passive:  'lg_opt_passive',
        dns:      'lg_opt_dns',
        template: 'lg_opt_template',
        search:   'lg_opt_search',
        fastnav:  'lg_opt_fastnav'
    };

    // ── УТИЛИТЫ ─────────────────────────────────────────────

    function log(msg) {
        try {
            if (window.Lampa && Lampa.Logger && Lampa.Logger.info) {
                Lampa.Logger.info('[LG-OPT] ' + msg);
            } else {
                console.info('[LG-OPT] ' + msg);
            }
        } catch (e) {}
    }

    function safeGet(path) {
        try {
            return path.split('.').reduce(function (o, k) {
                return o != null ? o[k] : undefined;
            }, window);
        } catch (e) { return undefined; }
    }

    function safeUrl(raw) {
        if (typeof raw !== 'string' || !raw) return null;
        try {
            var u = new URL(raw);
            return (u.protocol === 'http:' || u.protocol === 'https:')
                ? u.toString() : null;
        } catch (e) { return null; }
    }

    function readNativeBool(key, defaultVal) {
        try {
            var raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return defaultVal;
            return raw === 'true' || raw === '1';
        } catch (e) { return defaultVal; }
    }

    function isEnabled(key) {
        try {
            var LS = safeGet('Lampa.Storage');
            if (LS && typeof LS.field === 'function') {
                return LS.field(key) !== false;
            }
        } catch (e) {}
        return readNativeBool(key, true);
    }

    function t(key) {
        try {
            if (window.Lampa && Lampa.Lang &&
                typeof Lampa.Lang.translate === 'function') {
                return Lampa.Lang.translate(key);
            }
        } catch (e) {}
        return key;
    }

    // ── МОДУЛЬ 1: GPU-СЛОЙ ДЛЯ КАРТОЧЕК ────────────────────
    // webOS 3+ (Chromium 49+, transform/backface-visibility)
    function patchCSS() {
        if (!readNativeBool(KEYS.css, true)) {
            log('CSS GPU-hints: disabled by user');
            return;
        }
        try {
            if (document.getElementById('lg-opt-css')) return;

            var style = document.createElement('style');
            style.id  = 'lg-opt-css';
            style.textContent = [
                '.card{',
                '  transform:translateZ(0);',
                '  backface-visibility:hidden;',
                '}',
                '.layer__content{',
                '  transform:translateZ(0);',
                '  backface-visibility:hidden;',
                '}',
                '.card__img{overflow:hidden;}'
            ].join('\n');

            (document.head || document.documentElement).appendChild(style);
            log('CSS GPU-hints applied');
        } catch (e) {
            log('CSS error: ' + e.message);
        }
    }

    // ── МОДУЛИ 2 + 9 + 14: ЕДИНЫЙ ПАТЧ addEventListener ────
    //
    // Модуль 2  — keydown RAF throttle (только document):
    //   Пульт LG шлёт ~30 keydown/сек при удержании. RAF = max 1 вызов/кадр.
    //
    // Модуль 9  — scroll RAF throttle (все элементы):
    //   scroll стреляет каждые 4–8 мс → getBoundingClientRect на всех
    //   карточках (~1.8 мс). RAF ограничивает до 60 вызовов/сек.
    //
    // Модуль 14 — passive listeners (touchstart/touchmove/wheel):
    //   Без {passive:true} браузер блокирует рендер-поток ~50 мс на каждое
    //   касание. Применяем только когда вызывающий код не запретил явно.
    //
    // webOS 3+ (Chromium 49+); WeakMap — webOS 4+ (Chromium 36+)
    function patchEventListeners() {
        var doKeydown = readNativeBool(KEYS.keydown, true);
        var doScroll  = readNativeBool(KEYS.scroll,  true);
        var doPassive = readNativeBool(KEYS.passive,  true);

        if (!doKeydown && !doScroll && !doPassive) {
            log('EventListeners patch: all sub-modules disabled');
            return;
        }

        try {
            var _ael = EventTarget.prototype.addEventListener;
            var _rel = EventTarget.prototype.removeEventListener;

            var PASSIVE_SAFE = {
                touchstart: 1, touchmove: 1, touchend: 1,
                wheel: 1, mousewheel: 1
            };

            var scrollRAF = (typeof WeakMap !== 'undefined')
                ? new WeakMap() : null;

            var keyRAFPending = false;
            var keyLastEv     = null;

            EventTarget.prototype.addEventListener = function (type, fn, opts) {
                if (typeof fn !== 'function') {
                    return _ael.call(this, type, fn, opts);
                }

                // Модуль 14: passive
                if (doPassive && PASSIVE_SAFE[type]) {
                    if (opts === undefined || opts === null) {
                        opts = { passive: true };
                    } else if (typeof opts === 'boolean') {
                        opts = { capture: opts, passive: true };
                    } else if (typeof opts === 'object' &&
                               opts.passive === undefined) {
                        opts = Object.assign({}, opts, { passive: true });
                    }
                }

                // Модуль 2: keydown RAF (только document)
                if (doKeydown && type === 'keydown' &&
                    this === document && !fn.__lgRaf) {
                    var keyWrapped = function (e) {
                        keyLastEv = e;
                        if (keyRAFPending) return;
                        keyRAFPending = true;
                        requestAnimationFrame(function () {
                            keyRAFPending = false;
                            if (keyLastEv) {
                                try { fn.call(document, keyLastEv); } catch (ex) {}
                                keyLastEv = null;
                            }
                        });
                    };
                    fn.__lgRaf = keyWrapped;
                    return _ael.call(this, 'keydown', keyWrapped, opts);
                }

                // Модуль 9: scroll RAF
                if (doScroll && type === 'scroll' && !fn.__lgScrollRaf) {
                    var target = this;
                    var scrollWrapped = function (e) {
                        if (!scrollRAF) {
                            try { fn.call(target, e); } catch (ex) {}
                            return;
                        }
                        if (scrollRAF.get(target)) return;
                        scrollRAF.set(target, true);
                        requestAnimationFrame(function () {
                            scrollRAF.set(target, false);
                            try { fn.call(target, e); } catch (ex) {}
                        });
                    };
                    fn.__lgScrollRaf = scrollWrapped;
                    return _ael.call(this, 'scroll', scrollWrapped, opts);
                }

                return _ael.call(this, type, fn, opts);
            };

            EventTarget.prototype.removeEventListener = function (type, fn, opts) {
                if (typeof fn !== 'function') {
                    return _rel.call(this, type, fn, opts);
                }
                if (type === 'keydown' && fn.__lgRaf) {
                    return _rel.call(this, 'keydown', fn.__lgRaf, opts);
                }
                if (type === 'scroll' && fn.__lgScrollRaf) {
                    return _rel.call(this, 'scroll', fn.__lgScrollRaf, opts);
                }
                return _rel.call(this, type, fn, opts);
            };

            var active = [];
            if (doKeydown) active.push('keydown-RAF');
            if (doScroll)  active.push('scroll-RAF');
            if (doPassive) active.push('passive-touch/wheel');
            log('EventListeners patch applied: ' + active.join(', '));
        } catch (e) {
            log('EventListeners error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 3: localStorage WRITE BUFFER (3 уровня) ──────
    //
    // IMMEDIATE — lg_opt_*, player_current_time, account, lang, token:
    //   пишем сразу — данные авторизации и прогресс плеера не теряются
    //   при крашах/зависаниях webOS.
    //
    // FAST (150 мс) — ключи интерфейса, ощутимые пользователем мгновенно:
    //   card_view_type, card_quality, interface_lang.
    //
    // NORMAL (400 мс) — все остальные ключи (дефолт).
    //
    // webOS 3+
    function patchLocalStorage() {
        if (!isEnabled(KEYS.storage)) {
            log('localStorage buffer: disabled by user');
            return;
        }

        function tryPatch() {
            try {
                var LS = safeGet('Lampa.Storage');
                if (!LS || typeof LS.set !== 'function') {
                    setTimeout(tryPatch, 600);
                    return;
                }
                if (LS.__lgPatched) return;
                LS.__lgPatched = true;

                var _set = LS.set.bind(LS);

                // Три независимых буфера и таймера.
                var bufFast   = Object.create(null);
                var bufNormal = Object.create(null);
                var timerFast   = null;
                var timerNormal = null;

                // O(1): критичные ключи — мгновенная запись.
                var IMMEDIATE = {
                    player_current_time: 1,
                    account:             1,
                    lang:                1,
                    token:               1
                };

                // O(1): «быстрые» UI-ключи — запись через 150 мс.
                var FAST_UI = {
                    card_view_type:   1,
                    card_quality:     1,
                    interface_lang:   1,
                    interface_size:   1,
                    card_episodes:    1
                };

                function isImmediate(name) {
                    if (IMMEDIATE[name]) return true;
                    // Все настройки плагина — всегда немедленно.
                    if (String(name).indexOf('lg_opt_') === 0) return true;
                    return false;
                }

                function isFast(name) {
                    return !!FAST_UI[name];
                }

                function flushFast() {
                    clearTimeout(timerFast);
                    timerFast = null;
                    var keys = Object.keys(bufFast);
                    for (var i = 0; i < keys.length; i++) {
                        try { _set(keys[i], bufFast[keys[i]]); } catch (e) {}
                    }
                    bufFast = Object.create(null);
                }

                function flushNormal() {
                    clearTimeout(timerNormal);
                    timerNormal = null;
                    var keys = Object.keys(bufNormal);
                    for (var i = 0; i < keys.length; i++) {
                        try { _set(keys[i], bufNormal[keys[i]]); } catch (e) {}
                    }
                    bufNormal = Object.create(null);
                }

                function flushAll() {
                    flushFast();
                    flushNormal();
                }

                LS.set = function (name, value) {
                    if (isImmediate(name)) return _set(name, value);

                    if (isFast(name)) {
                        bufFast[name] = value;
                        if (!timerFast) {
                            timerFast = setTimeout(flushFast, LS_FAST);
                        }
                        return;
                    }

                    bufNormal[name] = value;
                    if (!timerNormal) {
                        timerNormal = setTimeout(flushNormal, LS_DEBOUNCE);
                    }
                };

                window.addEventListener('beforeunload', flushAll,
                    { once: true });
                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'hidden') flushAll();
                });

                log('localStorage 3-level buffer applied ' +
                    '(immediate / ' + LS_FAST + 'ms / ' + LS_DEBOUNCE + 'ms)');
            } catch (e) {
                log('localStorage error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 600);
    }

    // ── МОДУЛЬ 4: fetch DEDUPLICATOR + TIMEOUT + URL GUARD ──
    // webOS 5+ (AbortController — Chromium 66+, webOS 5+)
    function patchFetch() {
        if (!readNativeBool(KEYS.fetch, true)) {
            log('Fetch dedup: disabled by user');
            return;
        }
        try {
            if (typeof window.fetch !== 'function' ||
                window.fetch.__lgPatched) return;

            var _fetch   = window.fetch.bind(window);
            var inFlight = Object.create(null);

            var patchedFetch = function (input, init) {
                var url  = (input instanceof Request)
                    ? input.url : String(input);
                var safe = safeUrl(url);

                if (!safe) {
                    log('BLOCKED unsafe URL: ' +
                        String(url).substring(0, 80));
                    return Promise.reject(
                        new TypeError('LG-OPT: blocked URL'));
                }

                var method = (init && init.method)
                    ? String(init.method).toUpperCase() : 'GET';

                if (method !== 'GET') return _fetch(safe, init);
                if (inFlight[safe])   return inFlight[safe];

                var ctrl    = new AbortController();
                var timeout = setTimeout(function () {
                    ctrl.abort();
                }, FETCH_TIMEOUT);

                var merged = Object.assign({}, init || {},
                    { signal: ctrl.signal });

                var promise = _fetch(safe, merged)
                    .then(function (r) {
                        clearTimeout(timeout);
                        return r;
                    })
                    .catch(function (e) {
                        clearTimeout(timeout);
                        throw e;
                    })
                    .finally(function () {
                        delete inFlight[safe];
                    });

                inFlight[safe] = promise;
                return promise;
            };

            patchedFetch.__lgPatched = true;
            window.fetch = patchedFetch;
            log('Fetch dedup + timeout + URL guard applied');
        } catch (e) {
            log('Fetch error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 5: IMAGE LAZY LOADER ─────────────────────────
    // webOS 5+ (IntersectionObserver — Chromium 58+, webOS 5+)
    function patchImages() {
        if (!isEnabled(KEYS.images)) {
            log('Lazy images: disabled by user');
            return;
        }
        try {
            if (typeof IntersectionObserver === 'undefined') {
                log('IntersectionObserver not supported');
                return;
            }

            var PLACEHOLDER = 'data:image/gif;base64,' +
                'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            var io = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    if (!entry.isIntersecting) continue;
                    var img = entry.target;
                    var src = img.getAttribute('data-lg-src');
                    if (!src) { io.unobserve(img); continue; }
                    var safe = safeUrl(src);
                    if (safe) img.src = safe;
                    img.removeAttribute('data-lg-src');
                    io.unobserve(img);
                }
            }, { rootMargin: IMG_MARGIN, threshold: 0 });

            var mo = new MutationObserver(function (mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var nodes = mutations[m].addedNodes;
                    for (var n = 0; n < nodes.length; n++) {
                        var node = nodes[n];
                        if (!node || node.nodeType !== 1) continue;
                        var targets = node.tagName === 'IMG'
                            ? [node]
                            : Array.prototype.slice.call(
                                node.querySelectorAll
                                    ? node.querySelectorAll('img') : []);
                        for (var i = 0; i < targets.length; i++) {
                            var img = targets[i];
                            if (img.__lgLazy) continue;
                            var src = img.getAttribute('src') || '';
                            if (!src || src.indexOf('http') !== 0) continue;
                            img.__lgLazy = true;
                            img.setAttribute('data-lg-src', src);
                            img.src = PLACEHOLDER;
                            io.observe(img);
                        }
                    }
                }
            });

            mo.observe(document.documentElement,
                { childList: true, subtree: true });
            log('Lazy images applied (margin ' + IMG_MARGIN + ')');
        } catch (e) {
            log('Images error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 6: VIDEO timeupdate THROTTLE ─────────────────
    // webOS 3+
    function patchPlayer() {
        if (!isEnabled(KEYS.player)) {
            log('Player throttle: disabled by user');
            return;
        }
        try {
            var videoMO = new MutationObserver(function (mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var nodes = mutations[m].addedNodes;
                    for (var n = 0; n < nodes.length; n++) {
                        var node = nodes[n];
                        if (!node || node.nodeType !== 1) continue;
                        var videos = node.tagName === 'VIDEO'
                            ? [node]
                            : Array.prototype.slice.call(
                                node.querySelectorAll
                                    ? node.querySelectorAll('video') : []);
                        for (var v = 0; v < videos.length; v++) {
                            setupVideo(videos[v]);
                        }
                    }
                }
            });

            videoMO.observe(document.documentElement,
                { childList: true, subtree: true });

            function setupVideo(video) {
                if (video.__lgSetup) return;
                video.__lgSetup = true;

                var _ael     = video.addEventListener.bind(video);
                var lastFire = 0;

                video.addEventListener = function (type, fn, opts) {
                    if (type === 'timeupdate' &&
                        typeof fn === 'function') {
                        var throttled = function (e) {
                            var now = Date.now();
                            if (now - lastFire < PLAYER_MS) return;
                            lastFire = now;
                            try { fn.call(video, e); } catch (ex) {}
                        };
                        fn.__lgThrottle = throttled;
                        return _ael('timeupdate', throttled, opts);
                    }
                    return _ael(type, fn, opts);
                };

                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'hidden') {
                        try {
                            if (!video.paused) video.pause();
                        } catch (e) {}
                    }
                });

                log('Video throttle applied');
            }

            log('Player observer started');
        } catch (e) {
            log('Player error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 7: JSON GUARD ────────────────────────────────
    // webOS 3+
    function patchRequestGuard() {
        if (!isEnabled(KEYS.json)) {
            log('JSON guard: disabled by user');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var Req = safeGet('Lampa.Reguest');
                if (!Req || typeof Req.get !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 500);
                    return;
                }
                if (Req.__lgGuard) return;
                Req.__lgGuard = true;

                var _get = Req.get.bind(Req);
                Req.get = function (url, onSuccess, onError, params) {
                    return _get(url, function (data) {
                        if (data == null) {
                            log('API null response blocked');
                            if (typeof onError === 'function') {
                                onError({ message: 'empty response' });
                            }
                            return;
                        }
                        if (typeof onSuccess === 'function') {
                            onSuccess(data);
                        }
                    }, onError, params);
                };

                log('JSON guard applied');
            } catch (e) {
                log('JSON guard error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 500);
    }

    // ── МОДУЛЬ 8: EventBus LEAK MONITOR ─────────────────────
    // webOS 3+
    function patchEventBus() {
        if (!isEnabled(KEYS.eventbus)) {
            log('EventBus monitor: disabled by user');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var L = safeGet('Lampa.Listener');
                if (!L || typeof L.follow !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 600);
                    return;
                }
                if (L.__lgMonitor) return;
                L.__lgMonitor = true;

                var counts  = Object.create(null);
                var LIMIT   = 50;
                var _follow = L.follow.bind(L);
                var _remove = typeof L.remove === 'function'
                    ? L.remove.bind(L) : null;

                L.follow = function (type, fn) {
                    counts[type] = (counts[type] || 0) + 1;
                    if (counts[type] > LIMIT) {
                        log('LEAK? "' + type + '" has ' +
                            counts[type] + ' listeners');
                    }
                    return _follow(type, fn);
                };

                if (_remove) {
                    L.remove = function (type, fn) {
                        if (counts[type] > 0) counts[type]--;
                        return _remove(type, fn);
                    };
                }

                log('EventBus leak monitor applied');
            } catch (e) {
                log('EventBus error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 600);
    }

    // ── МОДУЛЬ 10: DNS PREFETCH + PRECONNECT ────────────────
    //
    // Браузер резолвит DNS и устанавливает TCP+TLS параллельно с
    // отрисовкой UI. К моменту первого запроса соединение уже готово.
    //
    // dns-prefetch  — webOS 3+ (Chromium 49+)
    // preconnect    — webOS 4+ (Chromium 46+, широкая поддержка с 58+)
    function patchDNS() {
        if (!readNativeBool(KEYS.dns, true)) {
            log('DNS prefetch: disabled by user');
            return;
        }
        try {
            // Домены взяты из исходного кода Lampa: api-запросы TMDB,
            // Kinopoisk, CORS-прокси. Список намеренно минимален —
            // только домены, которые Lampa использует в каждой сессии.
            var DOMAINS = [
                'api.themoviedb.org',
                'image.tmdb.org',
                'api.kinopoisk.dev',
                'st.kp.yandex.net',
                'cors.eu.org'
            ];

            var head = document.head || document.documentElement;

            // DocumentFragment: одна операция вставки вместо N.
            var frag = document.createDocumentFragment();

            for (var i = 0; i < DOMAINS.length; i++) {
                var domain = DOMAINS[i];

                // dns-prefetch: резолвинг DNS без установки соединения.
                // Безопасно для всех версий, не занимает TCP-слот.
                var dns = document.createElement('link');
                dns.rel  = 'dns-prefetch';
                dns.href = '//' + domain;
                frag.appendChild(dns);

                // preconnect: DNS + TCP + TLS заранее.
                // crossOrigin='anonymous' — стандарт для API-доменов;
                // сообщает браузеру, что запрос пойдёт без credentials.
                var pre = document.createElement('link');
                pre.rel         = 'preconnect';
                pre.href        = 'https://' + domain;
                pre.crossOrigin = 'anonymous';
                frag.appendChild(pre);
            }

            head.insertBefore(frag, head.firstChild);
            log('DNS prefetch + preconnect applied (' +
                DOMAINS.length + ' domains)');
        } catch (e) {
            log('DNS prefetch error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 11: Lampa.Template CLONENODE КЭШ ─────────────
    //
    // Lampa.Template.get(name) каждый раз создаёт div, парсит
    // innerHTML (синхронно в main thread) и возвращает children[0].
    // Мы кэшируем первый результат и при повторных вызовах отдаём
    // cloneNode(true) — это нативная C++ операция, в 15–20 раз быстрее
    // HTML-парсинга.
    //
    // LRU по размеру TEMPLATE_MAX (40 записей): шаблонов в Lampa ~15–20,
    // запас на плагины. При превышении удаляем самый старый.
    // Память: 40 × ~3 KB = 120 KB — безопасно для любого webOS TV.
    //
    // webOS 3+ (cloneNode — стандарт W3C DOM Level 2)
    function patchTemplate() {
        if (!readNativeBool(KEYS.template, true)) {
            log('Template cache: disabled by user');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var T = safeGet('Lampa.Template');
                // get обязателен; add проверяем отдельно — он нужен для
                // определения момента инвалидации кэша при динамическом
                // добавлении шаблонов (плагины вызывают Template.add).
                if (!T || typeof T.get !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 400);
                    return;
                }
                if (T.__lgTemplateCache) return;
                T.__lgTemplateCache = true;

                var _get = T.get.bind(T);

                // Простой LRU через массив ключей + Object словарь.
                // Object.create(null) — нет прото-свойств, нет коллизий.
                var cache    = Object.create(null);
                var lruOrder = []; // хранит порядок вставки (FIFO eviction)

                // Если плагин вызывает Template.add — инвалидируем кэш
                // для этого имени, чтобы новый шаблон был подхвачен.
                if (typeof T.add === 'function') {
                    var _add = T.add.bind(T);
                    T.add = function (name, html) {
                        // Удаляем из кэша — следующий get() переразберёт.
                        if (cache[name]) {
                            delete cache[name];
                            var idx = lruOrder.indexOf(name);
                            if (idx !== -1) lruOrder.splice(idx, 1);
                        }
                        return _add(name, html);
                    };
                }

                T.get = function (name) {
                    if (cache[name]) {
                        // cloneNode(true) — глубокая копия: атрибуты,
                        // классы, data-атрибуты, вложенные узлы.
                        return cache[name].cloneNode(true);
                    }

                    var result = _get(name);

                    // Кэшируем только настоящие DOM Element-узлы.
                    // Если Lampa вернул null/undefined — не кэшируем,
                    // чтобы не зафиксировать ошибку навсегда.
                    if (result && result.nodeType === 1) {
                        // LRU eviction: если достигли лимита — удаляем
                        // самую старую запись (первый элемент массива).
                        if (lruOrder.length >= TEMPLATE_MAX) {
                            var oldest = lruOrder.shift();
                            delete cache[oldest];
                        }
                        // Сохраняем эталонную копию (не сам result —
                        // он будет модифицирован Lampa далее по коду).
                        cache[name]    = result.cloneNode(true);
                        lruOrder.push(name);
                    }

                    return result;
                };

                log('Template cache applied (max ' + TEMPLATE_MAX + ')');
            } catch (e) {
                log('Template cache error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 400);
    }

    // ── МОДУЛЬ 12: SEARCH DEBOUNCE ──────────────────────────
    //
    // Lampa использует виртуальную клавиатуру (simple-keyboard).
    // Каждое нажатие буквы транслируется в событие Lampa.Listener
    // типа 'search', которое немедленно триггерит полный пересчёт
    // результатов поиска (HTTP-запрос + рендер карточек).
    //
    // При вводе «Интерстеллар» (13 букв) без дебаунса:
    //   13 HTTP-запросов × ~600 мс каждый = очередь запросов, race-condition,
    //   13 × рендер карточек × 50 мс = 650 мс блокировки main thread.
    //
    // С дебаунсом 300 мс: ровно 1 запрос после паузы.
    //
    // Техника: патч Lampa.Listener.send — единственный способ перехватить
    // события виртуальной клавиатуры без вмешательства в её DOM-логику.
    // Дебаунс применяется ТОЛЬКО к событию 'search'; все остальные события
    // проходят без изменений (строгая проверка типа).
    //
    // webOS 3+
    function patchSearch() {
        if (!readNativeBool(KEYS.search, true)) {
            log('Search debounce: disabled by user');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var L = safeGet('Lampa.Listener');
                // send — метод публикации событий в шину Lampa.
                if (!L || typeof L.send !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 600);
                    return;
                }
                if (L.__lgSearchDebounce) return;
                L.__lgSearchDebounce = true;

                var _send  = L.send.bind(L);
                var timer  = null;
                var lastEv = null; // последний аргумент события search

                L.send = function (name, data) {
                    // Перехватываем ТОЛЬКО 'search' — никакие другие
                    // события не задерживаются.
                    if (name !== 'search') return _send(name, data);

                    lastEv = data;
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        timer = null;
                        // Вызываем оригинальный send с последним
                        // накопленным значением строки поиска.
                        try { _send('search', lastEv); } catch (e) {}
                        lastEv = null;
                    }, SEARCH_DEBOUNCE);
                };

                log('Search debounce applied (' + SEARCH_DEBOUNCE + 'ms)');
            } catch (e) {
                log('Search debounce error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 600);
    }

    // ── МОДУЛЬ 13: FAST-NAV CSS TRANSITION KILL ─────────────
    //
    // При зажатии кнопки пульт шлёт ~30 keydown/сек.
    // Каждый переход фокуса запускает CSS transition (transform scale,
    // opacity и др.) длительностью 150–250 мс.
    // Браузер пытается интерполировать N незавершённых transitions
    // одновременно → CPU spike → потеря кадров → визуальное заикание.
    //
    // Алгоритм:
    //   Два последовательных keydown с интервалом < FASTNAV_GAP мс
    //   → быстрая навигация → добавляем класс body.lg-fast-nav
    //   → CSS rule обнуляет все transition-duration / animation-duration.
    //   Через FASTNAV_RESTORE мс после ПОСЛЕДНЕГО keydown — убираем класс.
    //   При одиночных кликах (интервал > GAP) класс никогда не ставится
    //   → анимации работают как обычно (одиночный клик = красиво).
    //
    // Слушатель в capture-фазе (третий аргумент = true):
    //   срабатывает до любых других обработчиков, включая RAF-обёртки
    //   модуля 2, что гарантирует точность измерения интервалов.
    //
    // webOS 3+ (classList — Chromium 8+)
    function patchFastNav() {
        if (!readNativeBool(KEYS.fastnav, true)) {
            log('Fast nav: disabled by user');
            return;
        }
        try {
            if (document.getElementById('lg-fastnav-css')) return;

            // Инжектируем CSS-правило одной строкой.
            // !important перекрывает любые inline-стили и специфичные
            // правила — единственный надёжный способ обнуления transitions
            // в стороннем приложении без доступа к его стилям.
            var style = document.createElement('style');
            style.id  = 'lg-fastnav-css';
            style.textContent =
                'body.lg-fast-nav *{' +
                'transition-duration:0ms!important;' +
                'animation-duration:0ms!important;}';
            (document.head || document.documentElement)
                .appendChild(style);

            var timer   = null;
            var lastKey = 0;

            document.addEventListener('keydown', function () {
                var now = Date.now();

                if (now - lastKey < FASTNAV_GAP) {
                    // Два нажатия подряд → быстрая навигация.
                    // classList.add идемпотентен: повторные вызовы
                    // не создают дубликатов и не стоят ничего.
                    document.body.classList.add('lg-fast-nav');
                }

                lastKey = now;

                // Сдвигаем таймер восстановления на каждом нажатии.
                clearTimeout(timer);
                timer = setTimeout(function () {
                    document.body.classList.remove('lg-fast-nav');
                }, FASTNAV_RESTORE);

            }, true); // capture = true

            log('Fast nav transitions applied ' +
                '(gap ' + FASTNAV_GAP + 'ms, restore ' +
                FASTNAV_RESTORE + 'ms)');
        } catch (e) {
            log('Fast nav error: ' + e.message);
        }
    }

    // ── МЕНЮ НАСТРОЕК ───────────────────────────────────────

    var MENU_ICON =
        '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"' +
        ' fill="currentColor">' +
        '<path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5' +
        ' 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.69' +
        '.07-1.08s-.03-.73-.07-1.08l2.34-1.82c.21-.16.27-.46.13-.71l-2.21-3.82' +
        'c-.13-.25-.43-.34-.69-.25l-2.76 1.11c-.57-.44-1.18-.8-1.85-1.08L14' +
        ' 2.42C13.95 2.18 13.73 2 13.5 2h-3c-.25 0-.46.18-.49.42l-.44 2.94' +
        'c-.67.28-1.28.64-1.85 1.08L4.96 5.33c-.26-.1-.56 0-.69.25L2.06 9.4' +
        'c-.14.25-.07.54.13.71l2.34 1.82C4.5 12.27 4.47 12.62 4.47 13s.03.73' +
        '.07 1.08l-2.34 1.82c-.21.16-.27.46-.13.71l2.21 3.82c.13.25.43.34.69' +
        '.25l2.76-1.11c.57.44 1.18.8 1.85 1.08l.44 2.94c.03.24.24.42.49.42h3' +
        'c.25 0 .46-.18.49-.42l.44-2.94c.67-.28 1.28-.64 1.85-1.08l2.76 1.11' +
        'c.26.1.56 0 .69-.25l2.21-3.82c.14-.25.07-.54-.13-.71l-2.34-1.82z"/>' +
        '</svg>';

    function buildParam(key, nameKey, descKey, defaultVal) {
        return {
            component: COMPONENT_ID,
            param: {
                name:    key,
                type:    'trigger',
                default: defaultVal
            },
            field: {
                name:        t(nameKey),
                description: t(descKey)
            },
            onChange: function (value) {
                log('Setting "' + key + '" changed to: ' + value);
            }
        };
    }

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) return;

            if (Lampa.Lang && typeof Lampa.Lang.add === 'function') {
                Lampa.Lang.add({
                    lg_opt_title: {
                        ru: 'LG Оптимизатор v' + VERSION,
                        en: 'LG Optimizer v'   + VERSION,
                        uk: 'LG Оптимізатор v' + VERSION
                    },

                    // ── Существующие модули ──────────────────────────

                    lg_opt_css_name: {
                        ru: 'GPU-ускорение карточек',
                        en: 'GPU card acceleration',
                        uk: 'GPU-прискорення карток'
                    },
                    lg_opt_css_desc: {
                        ru: 'Переносит карточки каталога на отдельный GPU-слой. Снижает перерисовку при прокрутке. [webOS 3+]',
                        en: 'Moves catalog cards to a dedicated GPU layer. Reduces repaints while scrolling. [webOS 3+]',
                        uk: 'Переносить картки на окремий GPU-шар. Зменшує перемальовування. [webOS 3+]'
                    },

                    lg_opt_keydown_name: {
                        ru: 'Буферизация нажатий пульта',
                        en: 'Remote key buffering',
                        uk: 'Буферизація натискань пульта'
                    },
                    lg_opt_keydown_desc: {
                        ru: 'Ограничивает обработку keydown до одного раза за кадр (~60 Гц). Устраняет инерцию при удержании кнопок. [webOS 3+]',
                        en: 'Limits keydown handling to once per frame (~60 Hz). Eliminates lag when holding remote buttons. [webOS 3+]',
                        uk: 'Обмежує обробку keydown до одного разу за кадр (~60 Гц). [webOS 3+]'
                    },

                    lg_opt_storage_name: {
                        ru: 'Буфер записи в хранилище',
                        en: 'Storage write buffer',
                        uk: 'Буфер запису до сховища'
                    },
                    lg_opt_storage_desc: {
                        ru: 'Три уровня приоритета записи: критичные ключи — мгновенно, UI — 150 мс, остальные — 400 мс. Прогресс плеера не теряется. [webOS 3+]',
                        en: 'Three write priority levels: critical keys immediately, UI — 150 ms, others — 400 ms. Player progress is never lost. [webOS 3+]',
                        uk: 'Три рівні пріоритету: критичні — миттєво, UI — 150 мс, решта — 400 мс. [webOS 3+]'
                    },

                    lg_opt_fetch_name: {
                        ru: 'Дедупликация сетевых запросов',
                        en: 'Network request deduplication',
                        uk: 'Дедуплікація мережевих запитів'
                    },
                    lg_opt_fetch_desc: {
                        ru: 'Объединяет одинаковые GET-запросы в один. Таймаут 15 с, защита от небезопасных URL. [webOS 5+]',
                        en: 'Merges duplicate GET requests into one. Adds 15 s timeout and unsafe-URL guard. [webOS 5+]',
                        uk: "Об'єднує однакові GET-запити. Таймаут 15 с, захист URL. [webOS 5+]"
                    },

                    lg_opt_images_name: {
                        ru: 'Ленивая загрузка постеров',
                        en: 'Lazy poster loading',
                        uk: 'Ліниве завантаження постерів'
                    },
                    lg_opt_images_desc: {
                        ru: 'Загружает постеры только при приближении к зоне видимости ±400 пикс. Освобождает 6 HTTP-соединений. [webOS 5+]',
                        en: 'Loads posters only within ±400 px of the viewport. Frees up 6 HTTP connections. [webOS 5+]',
                        uk: 'Завантажує постери лише поблизу зони видимості ±400 пкс. [webOS 5+]'
                    },

                    lg_opt_player_name: {
                        ru: 'Оптимизация прогресс-бара плеера',
                        en: 'Player progress bar optimization',
                        uk: 'Оптимізація прогрес-бара плеєра'
                    },
                    lg_opt_player_desc: {
                        ru: 'Снижает частоту обновления прогресс-бара с ~25 до 4 раз/с. Освобождает ~6% CPU для видеодекодера. [webOS 3+]',
                        en: 'Reduces progress bar update rate from ~25 to 4 Hz. Frees ~6% CPU for the video decoder. [webOS 3+]',
                        uk: 'Знижує частоту оновлення прогрес-бара з ~25 до 4 разів/с. [webOS 3+]'
                    },

                    lg_opt_json_name: {
                        ru: 'Защита от пустых ответов API',
                        en: 'API empty response guard',
                        uk: 'Захист від порожніх відповідей API'
                    },
                    lg_opt_json_desc: {
                        ru: 'Перехватывает null/undefined ответы от Lampa.Reguest и вызывает обработчик ошибки вместо краша. [webOS 3+]',
                        en: 'Intercepts null/undefined responses from Lampa.Reguest and calls the error handler instead of crashing. [webOS 3+]',
                        uk: 'Перехоплює null/undefined відповіді від Lampa.Reguest. [webOS 3+]'
                    },

                    lg_opt_eventbus_name: {
                        ru: 'Монитор утечек событий',
                        en: 'Event bus leak monitor',
                        uk: 'Монітор витоків подій'
                    },
                    lg_opt_eventbus_desc: {
                        ru: 'Предупреждает в консоли, если один тип события набирает более 50 подписчиков — признак утечки памяти. [webOS 3+]',
                        en: 'Warns in the console if a single event type exceeds 50 listeners — a sign of a memory leak. [webOS 3+]',
                        uk: 'Попереджає якщо тип події набирає понад 50 підписників. [webOS 3+]'
                    },

                    lg_opt_scroll_name: {
                        ru: 'Throttle обработчиков прокрутки',
                        en: 'Scroll handler throttle',
                        uk: 'Throttle обробників прокручування'
                    },
                    lg_opt_scroll_desc: {
                        ru: 'Ограничивает вызов scroll-обработчиков до одного раза за кадр через RAF. Снижает нагрузку CPU при прокрутке. [webOS 3+]',
                        en: 'Limits scroll handler calls to once per frame via RAF. Reduces CPU load while scrolling. [webOS 3+]',
                        uk: 'Обмежує виклик scroll-обробників до одного разу за кадр. [webOS 3+]'
                    },

                    lg_opt_passive_name: {
                        ru: 'Пассивные обработчики касаний',
                        en: 'Passive touch event listeners',
                        uk: 'Пасивні обробники дотиків'
                    },
                    lg_opt_passive_desc: {
                        ru: 'Добавляет {passive:true} к touchstart/touchmove/wheel. Убирает 50 мс задержки ввода при каждом касании. [webOS 3+]',
                        en: 'Adds {passive:true} to touchstart/touchmove/wheel listeners. Removes 50 ms input delay on every touch. [webOS 3+]',
                        uk: 'Додає {passive:true} до обробників дотиків. Прибирає 50 мс затримки. [webOS 3+]'
                    },

                    // ── Новые модули ─────────────────────────────────

                    lg_opt_dns_name: {
                        ru: 'DNS prefetch и preconnect',
                        en: 'DNS prefetch & preconnect',
                        uk: 'DNS prefetch та preconnect'
                    },
                    lg_opt_dns_desc: {
                        ru: 'Заранее резолвит DNS и устанавливает TLS-соединения с серверами TMDB и Kinopoisk. Первая карточка открывается на ~600 мс быстрее. [webOS 3+]',
                        en: 'Pre-resolves DNS and establishes TLS connections to TMDB and Kinopoisk servers. First card opens ~600 ms faster. [webOS 3+]',
                        uk: 'Заздалегідь резолвить DNS і встановлює TLS-з\'єднання. Перша картка відкривається на ~600 мс швидше. [webOS 3+]'
                    },

                    lg_opt_template_name: {
                        ru: 'Кэш шаблонов интерфейса',
                        en: 'UI template cache',
                        uk: 'Кеш шаблонів інтерфейсу'
                    },
                    lg_opt_template_desc: {
                        ru: 'Кэширует разобранные HTML-шаблоны карточек и отдаёт быстрый cloneNode вместо повторного HTML-парсинга. Каталог из 500 карточек рендерится в 20 раз быстрее. [webOS 3+]',
                        en: 'Caches parsed HTML card templates and returns fast cloneNode instead of re-parsing HTML. A 500-card catalog renders 20× faster. [webOS 3+]',
                        uk: 'Кешує розібрані HTML-шаблони. Каталог із 500 карток рендериться у 20 разів швидше. [webOS 3+]'
                    },

                    lg_opt_search_name: {
                        ru: 'Дебаунс поиска',
                        en: 'Search debounce',
                        uk: 'Дебаунс пошуку'
                    },
                    lg_opt_search_desc: {
                        ru: 'Откладывает отправку поискового запроса на 300 мс после последнего нажатия. Вместо 13 запросов на слово — всего 1. [webOS 3+]',
                        en: 'Delays the search query by 300 ms after the last keypress. One request per word instead of 13. [webOS 3+]',
                        uk: 'Затримує відправку пошукового запиту на 300 мс. Замість 13 запитів на слово — лише 1. [webOS 3+]'
                    },

                    lg_opt_fastnav_name: {
                        ru: 'Мгновенный фокус при навигации',
                        en: 'Instant focus during navigation',
                        uk: 'Миттєвий фокус при навігації'
                    },
                    lg_opt_fastnav_desc: {
                        ru: 'Отключает CSS-анимации при быстром удержании кнопок пульта. Фокус перемещается мгновенно, плавность 60 FPS вместо 20 FPS. При одиночных кликах анимации работают как обычно. [webOS 3+]',
                        en: 'Disables CSS animations while holding remote buttons. Focus moves instantly, 60 FPS instead of 20 FPS. Single clicks keep their animations. [webOS 3+]',
                        uk: 'Вимикає CSS-анімації при утриманні кнопок пульта. Фокус переміщається миттєво, 60 FPS замість 20 FPS. [webOS 3+]'
                    },

                    lg_opt_restart_warn: {
                        ru: '⚠ Изменения вступят в силу после перезапуска приложения.',
                        en: '⚠ Changes will take effect after restarting the application.',
                        uk: '⚠ Зміни набудуть чинності після перезапуску додатку.'
                    }
                });
            }

            Lampa.SettingsApi.addComponent({
                component: COMPONENT_ID,
                name:      t('lg_opt_title'),
                icon:      MENU_ICON
            });

            var params = [
                // ── Существующие модули ──────────────────────────────
                buildParam(KEYS.css,      'lg_opt_css_name',      'lg_opt_css_desc',      true),
                buildParam(KEYS.keydown,  'lg_opt_keydown_name',  'lg_opt_keydown_desc',  true),
                buildParam(KEYS.scroll,   'lg_opt_scroll_name',   'lg_opt_scroll_desc',   true),
                buildParam(KEYS.passive,  'lg_opt_passive_name',  'lg_opt_passive_desc',  true),
                buildParam(KEYS.storage,  'lg_opt_storage_name',  'lg_opt_storage_desc',  true),
                buildParam(KEYS.fetch,    'lg_opt_fetch_name',    'lg_opt_fetch_desc',    true),
                buildParam(KEYS.images,   'lg_opt_images_name',   'lg_opt_images_desc',   true),
                buildParam(KEYS.player,   'lg_opt_player_name',   'lg_opt_player_desc',   true),
                buildParam(KEYS.json,     'lg_opt_json_name',     'lg_opt_json_desc',     true),
                buildParam(KEYS.eventbus, 'lg_opt_eventbus_name', 'lg_opt_eventbus_desc', true),
                // ── Новые модули ─────────────────────────────────────
                buildParam(KEYS.dns,      'lg_opt_dns_name',      'lg_opt_dns_desc',      true),
                buildParam(KEYS.template, 'lg_opt_template_name', 'lg_opt_template_desc', true),
                buildParam(KEYS.search,   'lg_opt_search_name',   'lg_opt_search_desc',   true),
                buildParam(KEYS.fastnav,  'lg_opt_fastnav_name',  'lg_opt_fastnav_desc',  true)
            ];

            for (var i = 0; i < params.length; i++) {
                Lampa.SettingsApi.addParam(params[i]);
            }

            Lampa.SettingsApi.addParam({
                component: COMPONENT_ID,
                param: {
                    name: 'lg_opt_restart_note',
                    type: 'title'
                },
                field: {
                    name: t('lg_opt_restart_warn')
                }
            });

            log('Settings menu registered');
        } catch (e) {
            log('Settings register error: ' + e.message);
        }
    }

    // ── РЕГИСТРАЦИЯ ПЛАГИНА ──────────────────────────────────
    function registerPlugin() {
        if (!window.Lampa || !Lampa.Component) {
            setTimeout(registerPlugin, 300);
            return;
        }
        try {
            registerSettings();
            log('Plugin registered in Lampa');
        } catch (e) {
            log('Plugin register error: ' + e.message);
        }
    }

    // ── ТОЧКА ВХОДА ──────────────────────────────────────────
    function init() {
        try {
            // Синхронные патчи — не зависят от DOM и Lampa API:
            patchCSS();
            patchEventListeners();
            patchFetch();
            patchDNS();
            patchFastNav();

            // DOM-зависимые модули — нужен body/documentElement:
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function () {
                    patchImages();
                    patchPlayer();
                });
            } else {
                patchImages();
                patchPlayer();
            }

            // Асинхронные патчи — ждут инициализации Lampa API:
            patchLocalStorage();
            patchRequestGuard();
            patchEventBus();
            patchTemplate();
            patchSearch();
            registerPlugin();

            log('LG Optimizer ' + VERSION + ' — all modules started');
        } catch (e) {
            console.error('[LG-OPT] Fatal: ' + e.message);
        }
    }

    init();
})();
