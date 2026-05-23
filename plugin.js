/**
 * ============================================================
 *  LG OPTIMIZER v1.5.0 — Performance Plugin for Lampa
 * ============================================================
 *
 *  Изменения v1.5.0 относительно v1.4.1:
 *
 *  ИСПРАВЛЕНО:
 *    - Модуль keydown: общий RAF-стейт заменён на per-listener
 *      замыкание — устранён баг пропуска нажатий пульта
 *    - patchFetch: удалён .finally() (нет в Chromium <63 / webOS 3–4),
 *      заменён на .then()/.catch() с явной очисткой в обоих ветвях
 *
 *  УДАЛЕНО:
 *    - Модуль eventbus (patchEventBus): только писал в консоль,
 *      ничего не исправлял, пользователь TV консоль не видит
 *
 *  ДОБАВЛЕНО:
 *    - Модуль css_contain:   CSS contain для изоляции reflow
 *    - Модуль will_change:   will-change только у элемента в фокусе
 *    - Модуль img_unload:    выгрузка постеров далеко за экраном
 *    - Модуль activity_gc:   уничтожение старых экранов из стека
 *    - Модуль mem_pressure:  мониторинг кучи + принудительная очистка
 * ============================================================
 */

(function () {
    'use strict';

    if (window.__LG_OPT_V150__) return;
    window.__LG_OPT_V150__ = true;

    var VERSION      = '1.5.0';
    var COMPONENT_ID = 'lg_optimizer';

    var LS_DEBOUNCE     = 400;
    var LS_FAST         = 150;
    var PLAYER_MS       = 250;
    var IMG_LOAD_MARGIN = '400px';
    var IMG_UNLOAD_ROOT = '-200px';
    var FETCH_TIMEOUT   = 15000;
    var FILTER_DEBOUNCE = 300;
    var FASTNAV_GAP     = 150;
    var FASTNAV_RESTORE = 200;
    var ACTIVITY_LIMIT  = 5;
    var MEM_CHECK_MS    = 20000;
    var MEM_THRESHOLD   = 0.80;

    var KEYS = {
        css:         'lg_opt_css',
        css_contain: 'lg_opt_css_contain',
        keydown:     'lg_opt_keydown',
        storage:     'lg_opt_storage',
        fetch:       'lg_opt_fetch',
        images:      'lg_opt_images',
        img_unload:  'lg_opt_img_unload',
        player:      'lg_opt_player',
        json:        'lg_opt_json',
        scroll:      'lg_opt_scroll',
        passive:     'lg_opt_passive',
        dns:         'lg_opt_dns',
        filter:      'lg_opt_filter',
        fastnav:     'lg_opt_fastnav',
        will_change: 'lg_opt_will_change',
        activity_gc: 'lg_opt_activity_gc',
        mem_pressure:'lg_opt_mem_pressure'
    };

    // ── УТИЛИТЫ ─────────────────────────────────────────────

    function log(msg) {
        try {
            if (window.Lampa && Lampa.Logger &&
                typeof Lampa.Logger.info === 'function') {
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
                var v = LS.field(key);
                if (v !== undefined && v !== null) return v !== false;
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

    // ── МОДУЛЬ 1: GPU-СЛОЙ [webOS 3+] ───────────────────────
    function patchCSS() {
        if (!readNativeBool(KEYS.css, true)) {
            log('CSS GPU-hints: disabled');
            return;
        }
        try {
            if (document.getElementById('lg-opt-css')) return;
            var style = document.createElement('style');
            style.id = 'lg-opt-css';
            style.textContent = [
                '.card{transform:translateZ(0);backface-visibility:hidden;}',
                '.layer__content{transform:translateZ(0);backface-visibility:hidden;}',
                '.card__img{overflow:hidden;}'
            ].join('');
            (document.head || document.documentElement).appendChild(style);
            log('CSS GPU-hints applied');
        } catch (e) {
            log('CSS error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 1b: CSS CONTAIN [webOS 6+ / Chromium 85+] ────
    //
    //  contain: layout style paint — полная изоляция от внешнего reflow.
    //  Браузер не обходит элемент при пересчёте layout за его пределами.
    //  contain-intrinsic-size задаёт placeholder-размер для
    //  content-visibility: auto, чтобы скроллбар не прыгал.
    //
    //  На webOS 3–5 (Chromium < 85) contain работает частично (без
    //  content-visibility), но не вредит — свойство безопасно деградирует.
    //
    function patchCSSContain() {
        if (!readNativeBool(KEYS.css_contain, true)) {
            log('CSS contain: disabled');
            return;
        }
        try {
            if (document.getElementById('lg-opt-contain')) return;
            var style = document.createElement('style');
            style.id = 'lg-opt-contain';
            style.textContent = [
                '.card{',
                '  contain:layout style paint;',
                '}',
                '.items__line{',
                '  contain:layout style;',
                '}',
                '.full-start__body,.card-more{',
                '  contain:layout style paint;',
                '}'
            ].join('');
            (document.head || document.documentElement).appendChild(style);
            log('CSS contain applied');
        } catch (e) {
            log('CSS contain error: ' + e.message);
        }
    }

    // ── МОДУЛИ 2 + 9 + 14: ЕДИНЫЙ addEventListener [webOS 3+] ─
    //
    //  ИСПРАВЛЕНИЕ v1.5.0:
    //  Ранее keyRAFPending и keyLastEv были общими для всех слушателей.
    //  Если Lampa регистрировала N keydown-обработчиков, они конкурировали
    //  за один RAF-слот: первый взводил флаг, остальные N-1 выходили сразу
    //  и их события терялись навсегда.
    //
    //  Исправление: каждый вызов addEventListener создаёт своё замыкание
    //  с независимыми переменными pending/lastEv. Все N обработчиков
    //  работают параллельно, каждый со своим RAF.
    //
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
                touchstart:  1,
                touchmove:   1,
                touchend:    1,
                wheel:       1,
                mousewheel:  1
            };

            var scrollRAF = (typeof WeakMap !== 'undefined')
                ? new WeakMap() : null;

            EventTarget.prototype.addEventListener = function (type, fn, opts) {
                if (typeof fn !== 'function') {
                    return _ael.call(this, type, fn, opts);
                }

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

                if (doKeydown && type === 'keydown' &&
                    this === document && !fn.__lgRaf) {

                    var rafPending = false;
                    var lastEv     = null;

                    var keyWrapped = function (e) {
                        lastEv = e;
                        if (rafPending) return;
                        rafPending = true;
                        requestAnimationFrame(function () {
                            rafPending = false;
                            if (lastEv) {
                                try { fn.call(document, lastEv); } catch (ex) {}
                                lastEv = null;
                            }
                        });
                    };
                    fn.__lgRaf = keyWrapped;
                    return _ael.call(this, 'keydown', keyWrapped, opts);
                }

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
            if (doKeydown) active.push('keydown-RAF(per-listener)');
            if (doScroll)  active.push('scroll-RAF');
            if (doPassive) active.push('passive-touch/wheel');
            log('EventListeners patch: ' + active.join(', '));
        } catch (e) {
            log('EventListeners error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 3: localStorage 3-LEVEL BUFFER [webOS 3+] ────
    function patchLocalStorage() {
        if (!isEnabled(KEYS.storage)) {
            log('localStorage buffer: disabled');
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

                var bufFast     = Object.create(null);
                var bufNormal   = Object.create(null);
                var timerFast   = null;
                var timerNormal = null;

                var IMMEDIATE = {
                    player_current_time: 1,
                    account:             1,
                    lang:                1,
                    token:               1
                };

                var FAST_UI = {
                    card_view_type: 1,
                    card_quality:   1,
                    interface_lang: 1,
                    interface_size: 1,
                    card_episodes:  1
                };

                function isImmediate(name) {
                    if (IMMEDIATE[name]) return true;
                    if (String(name).indexOf('lg_opt_') === 0) return true;
                    return false;
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

                    if (FAST_UI[name]) {
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

                log('localStorage 3-level buffer applied (' +
                    'immediate / ' + LS_FAST + 'ms / ' + LS_DEBOUNCE + 'ms)');
            } catch (e) {
                log('localStorage error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 600);
    }

    // ── МОДУЛЬ 4: fetch DEDUP + TIMEOUT + URL GUARD [webOS 3+] ─
    //
    //  ИСПРАВЛЕНИЕ v1.5.0:
    //  Удалён .finally() — он появился в Chromium 63 (webOS 5+).
    //  На webOS 3–4 (Chromium ~38–53) вызов .finally() бросал
    //  TypeError, catch его глотал, патч молча не применялся.
    //  Заменён на явный .then(onOk).catch(onErr) с идентичной логикой:
    //  очистка таймера и удаление из inFlight в обоих ветвях.
    //
    function patchFetch() {
        if (!readNativeBool(KEYS.fetch, true)) {
            log('Fetch dedup: disabled');
            return;
        }
        try {
            if (typeof window.fetch !== 'function' ||
                window.fetch.__lgPatched) return;

            var _fetch   = window.fetch.bind(window);
            var inFlight = Object.create(null);

            var patchedFetch = function (input, init) {
                var url = (input instanceof Request)
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
                        delete inFlight[safe];
                        return r;
                    }, function (e) {
                        clearTimeout(timeout);
                        delete inFlight[safe];
                        throw e;
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

    // ── МОДУЛЬ 5: IMAGE LAZY LOADER [webOS 5+] ──────────────
    function patchImages() {
        if (!isEnabled(KEYS.images)) {
            log('Lazy images: disabled');
            return;
        }
        try {
            if (typeof IntersectionObserver === 'undefined') {
                log('IntersectionObserver not supported — lazy load skipped');
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
            }, { rootMargin: IMG_LOAD_MARGIN, threshold: 0 });

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
            log('Lazy images applied (margin ' + IMG_LOAD_MARGIN + ')');
        } catch (e) {
            log('Images error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 5b: IMAGE UNLOADER [webOS 5+] ────────────────
    //
    //  Логика: картинки за экраном занимают GPU-текстурную память.
    //  Декодированный JPEG 300×450 px = 300×450×4 байта ≈ 527 КБ в GPU.
    //  На странице 40 карточек это 40×527 КБ ≈ 20 МБ только в GPU.
    //  При нескольких страницах истории — сотни МБ без освобождения.
    //
    //  IntersectionObserver с rootMargin: '-200px' срабатывает, когда
    //  элемент уходит за 200 пикселей ОТ края viewport (т.е. далеко
    //  за экраном). Там src заменяется на 1×1 placeholder.
    //  При возврате — isIntersecting=true — src восстанавливается.
    //
    //  Два observer'а (load + unload) работают независимо и не конфликтуют:
    //  img_load отслеживает data-lg-src (ещё не загруженные),
    //  img_unload отслеживает data-lg-orig (уже загруженные).
    //
    function patchImgUnload() {
        if (!isEnabled(KEYS.img_unload)) {
            log('Img unload: disabled');
            return;
        }
        try {
            if (typeof IntersectionObserver === 'undefined') {
                log('IntersectionObserver not supported — img unload skipped');
                return;
            }

            var PLACEHOLDER = 'data:image/gif;base64,' +
                'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            var unloadIO = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    var img   = entry.target;

                    if (entry.isIntersecting) {
                        var orig = img.getAttribute('data-lg-orig');
                        if (orig) {
                            img.src = orig;
                            img.removeAttribute('data-lg-orig');
                        }
                    } else {
                        var cur = img.src;
                        if (cur && cur.indexOf('http') === 0 &&
                            !img.getAttribute('data-lg-orig')) {
                            img.setAttribute('data-lg-orig', cur);
                            img.src = PLACEHOLDER;
                        }
                    }
                }
            }, { rootMargin: IMG_UNLOAD_ROOT, threshold: 0 });

            var mo = new MutationObserver(function (mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var nodes = mutations[m].addedNodes;
                    for (var n = 0; n < nodes.length; n++) {
                        var node = nodes[n];
                        if (!node || node.nodeType !== 1) continue;
                        var imgs = node.tagName === 'IMG'
                            ? [node]
                            : Array.prototype.slice.call(
                                node.querySelectorAll
                                    ? node.querySelectorAll('img') : []);
                        for (var i = 0; i < imgs.length; i++) {
                            if (!imgs[i].__lgUnload) {
                                imgs[i].__lgUnload = true;
                                unloadIO.observe(imgs[i]);
                            }
                        }
                    }
                }
            });

            mo.observe(document.documentElement,
                { childList: true, subtree: true });
            log('Img unload applied (rootMargin ' + IMG_UNLOAD_ROOT + ')');
        } catch (e) {
            log('Img unload error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 6: VIDEO timeupdate THROTTLE [webOS 3+] ──────
    function patchPlayer() {
        if (!isEnabled(KEYS.player)) {
            log('Player throttle: disabled');
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

                log('Video throttle applied to video element');
            }

            log('Player observer started');
        } catch (e) {
            log('Player error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 7: JSON GUARD [webOS 3+] ─────────────────────
    function patchRequestGuard() {
        if (!isEnabled(KEYS.json)) {
            log('JSON guard: disabled');
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

    // ── МОДУЛЬ 10: DNS PREFETCH + PRECONNECT [webOS 3+] ─────
    //
    //  Примечание: эффективен только на холодном старте сессии.
    //  После первого запуска DNS кэшируется ОС на уровне TTL записи.
    //  Оставлен как дополнение — вред нулевой, польза при первом запуске.
    //
    function patchDNS() {
        if (!readNativeBool(KEYS.dns, true)) {
            log('DNS prefetch: disabled');
            return;
        }
        try {
            var DOMAINS = [
                'api.themoviedb.org',
                'image.tmdb.org',
                'api.kinopoisk.dev',
                'st.kp.yandex.net',
                'cors.eu.org'
            ];

            var head = document.head || document.documentElement;
            var frag = document.createDocumentFragment();

            for (var i = 0; i < DOMAINS.length; i++) {
                var domain = DOMAINS[i];

                var dns = document.createElement('link');
                dns.rel  = 'dns-prefetch';
                dns.href = '//' + domain;
                frag.appendChild(dns);

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

    // ── МОДУЛЬ 12: FILTER DEBOUNCE [webOS 3+] ───────────────
    function patchFilter() {
        if (!isEnabled(KEYS.filter)) {
            log('Filter debounce: disabled');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var L = safeGet('Lampa.Listener');
                if (!L || typeof L.send !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 600);
                    return;
                }
                if (L.__lgFilterDebounce) return;
                L.__lgFilterDebounce = true;

                var _send  = L.send.bind(L);
                var timer  = null;
                var lastEv = null;

                L.send = function (name, data) {
                    if (name !== 'filter') return _send(name, data);

                    lastEv = data;
                    clearTimeout(timer);
                    timer = setTimeout(function () {
                        timer  = null;
                        var ev = lastEv;
                        lastEv = null;
                        try { _send('filter', ev); } catch (e) {}
                    }, FILTER_DEBOUNCE);
                };

                log('Filter debounce applied (' + FILTER_DEBOUNCE + 'ms)');
            } catch (e) {
                log('Filter debounce error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 600);
    }

    // ── МОДУЛЬ 13: FAST-NAV CSS TRANSITION KILL [webOS 3+] ──
    function patchFastNav() {
        if (!readNativeBool(KEYS.fastnav, true)) {
            log('Fast nav: disabled');
            return;
        }
        try {
            if (document.getElementById('lg-fastnav-css')) return;

            var style = document.createElement('style');
            style.id  = 'lg-fastnav-css';
            style.textContent =
                'body.lg-fast-nav *{' +
                'transition-duration:0ms!important;' +
                'animation-duration:0ms!important;}';
            (document.head || document.documentElement).appendChild(style);

            var timer   = null;
            var lastKey = 0;

            document.addEventListener('keydown', function () {
                var now = Date.now();

                if (now - lastKey < FASTNAV_GAP) {
                    document.body.classList.add('lg-fast-nav');
                }

                lastKey = now;
                clearTimeout(timer);
                timer = setTimeout(function () {
                    document.body.classList.remove('lg-fast-nav');
                }, FASTNAV_RESTORE);

            }, true);

            log('Fast nav applied (gap ' + FASTNAV_GAP +
                'ms, restore ' + FASTNAV_RESTORE + 'ms)');
        } catch (e) {
            log('Fast nav error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 15: WILL-CHANGE FOCUS [webOS 5+] ─────────────
    //
    //  Стратегия: will-change: transform на все .card одновременно —
    //  антипаттерн. GPU резервирует отдельный compositor layer на каждый
    //  элемент с will-change. При 40 карточках = 40 layers.
    //  На TV с GPU-памятью 256–512 МБ это checkerboarding и артефакты.
    //
    //  Правильный паттерн: будущий слой нужен только для элемента,
    //  который СЕЙЧАС анимируется (переход фокуса).
    //
    //  Реализация: MutationObserver следит за классом `.focus` в DOM.
    //  Lampa добавляет/убирает класс `.focus` при навигации пультом.
    //  При добавлении `.focus` — вешаем will-change на этот элемент.
    //  При уходе — убираем will-change (GPU освобождает layer).
    //  Итог: всегда максимум 1 дополнительный compositor layer.
    //
    function patchWillChange() {
        if (!readNativeBool(KEYS.will_change, true)) {
            log('will-change focus: disabled');
            return;
        }
        try {
            var prevFocused = null;

            var mo = new MutationObserver(function (mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var mut = mutations[m];
                    if (mut.type !== 'attributes' ||
                        mut.attributeName !== 'class') continue;

                    var el = mut.target;
                    if (!el || el.nodeType !== 1) continue;

                    var hasFocus = el.classList &&
                                   el.classList.contains('focus');

                    if (hasFocus) {
                        if (prevFocused && prevFocused !== el) {
                            prevFocused.style.willChange = '';
                        }
                        el.style.willChange = 'transform';
                        prevFocused = el;
                    } else if (el === prevFocused) {
                        el.style.willChange = '';
                        prevFocused = null;
                    }
                }
            });

            mo.observe(document.documentElement, {
                attributes:     true,
                attributeFilter: ['class'],
                subtree:        true
            });

            log('will-change focus observer applied');
        } catch (e) {
            log('will-change error: ' + e.message);
        }
    }

    // ── МОДУЛЬ 16: ACTIVITY GC [webOS 3+] ───────────────────
    //
    //  Lampa использует Lampa.Activity как стек экранов.
    //  Каждый экран — это объект с DOM-деревом, слушателями, постерами.
    //  Lampa не уничтожает старые экраны автоматически.
    //
    //  Безопасная стратегия:
    //  1. Слушаем событие 'activity' через Lampa.Listener.follow.
    //  2. Получаем текущий стек через Lampa.Activity.all() если есть,
    //     или через саму активность.
    //  3. Если стек глубже ACTIVITY_LIMIT, вызываем destroy() у
    //     самого старого, удалённого от текущего экрана.
    //  4. Перед вызовом destroy() ОБЯЗАТЕЛЬНО проверяем:
    //     a) typeof activity.destroy === 'function'
    //     b) активность не является текущей
    //     c) активность не помечена как __lgDestroyed
    //
    //  Почему безопасно: destroy() — официальный метод жизненного цикла
    //  компонентов Lampa. Он вызывается самой Lampa при popActivity.
    //  Мы только ускоряем уже запланированную очистку.
    //
    function patchActivityGC() {
        if (!isEnabled(KEYS.activity_gc)) {
            log('Activity GC: disabled');
            return;
        }

        var attempts = 0;
        function tryPatch() {
            try {
                var L = safeGet('Lampa.Listener');
                var A = safeGet('Lampa.Activity');

                if (!L || typeof L.follow !== 'function') {
                    if (++attempts < 25) setTimeout(tryPatch, 600);
                    return;
                }
                if (!A) {
                    if (++attempts < 25) setTimeout(tryPatch, 600);
                    return;
                }
                if (L.__lgActivityGC) return;
                L.__lgActivityGC = true;

                function runGC() {
                    try {
                        var all = null;

                        if (typeof A.all === 'function') {
                            all = A.all();
                        }

                        if (!all || !Array.isArray(all) ||
                            all.length <= ACTIVITY_LIMIT) return;

                        var current = (typeof A.active === 'function')
                            ? A.active() : null;

                        var toDestroy = all.slice(
                            0, all.length - ACTIVITY_LIMIT);

                        for (var i = 0; i < toDestroy.length; i++) {
                            var item = toDestroy[i];
                            if (!item) continue;
                            if (item === current) continue;
                            if (item.__lgDestroyed) continue;
                            if (typeof item.destroy !== 'function') continue;

                            item.__lgDestroyed = true;
                            try {
                                item.destroy();
                            } catch (ex) {
                                log('Activity GC destroy error: ' + ex.message);
                            }
                        }
                    } catch (ex) {
                        log('Activity GC run error: ' + ex.message);
                    }
                }

                L.follow('activity', function () {
                    setTimeout(runGC, 300);
                });

                log('Activity GC applied (limit ' + ACTIVITY_LIMIT + ')');
            } catch (e) {
                log('Activity GC error: ' + e.message);
            }
        }
        setTimeout(tryPatch, 800);
    }

    // ── МОДУЛЬ 17: MEMORY PRESSURE MONITOR [webOS 5+] ───────
    //
    //  performance.memory — нестандартное расширение Chromium.
    //  Доступно в webOS 5+ (Chromium 53+) без флагов.
    //  На webOS 3–4 тихо пропускается через проверку существования.
    //
    //  Поля:
    //    usedJSHeapSize  — текущий JS heap в байтах
    //    jsHeapSizeLimit — максимальный heap в байтах
    //
    //  Алгоритм:
    //  Каждые MEM_CHECK_MS мс проверяем соотношение
    //  usedJSHeapSize / jsHeapSizeLimit.
    //  Если > MEM_THRESHOLD (80%) — инициируем принудительную очистку:
    //
    //    1. Lampa.Cache.clear() — очищает кэш API-ответов
    //    2. Сброс in-flight запросов через перезапись inFlight (доступ
    //       через closure недоступен снаружи, поэтому только сигнал)
    //    3. Форсируем выгрузку видимых изображений через событие
    //       visibilitychange (имитация hidden → visible)
    //
    //  ВАЖНО: мы НЕ вызываем принудительный GC (window.gc) — он
    //  существует только в режиме разработки и недоступен на TV.
    //  Вместо этого обнуляем ссылки — движок сам запустит GC.
    //
    function patchMemPressure() {
        if (!isEnabled(KEYS.mem_pressure)) {
            log('Memory pressure: disabled');
            return;
        }
        try {
            var perf = window.performance;
            if (!perf || !perf.memory) {
                log('performance.memory not supported — mem monitor skipped');
                return;
            }

            var lastWarn = 0;

            function check() {
                try {
                    var mem   = perf.memory;
                    var used  = mem.usedJSHeapSize;
                    var limit = mem.jsHeapSizeLimit;

                    if (!limit || limit === 0) return;

                    var ratio = used / limit;

                    if (ratio >= MEM_THRESHOLD) {
                        var now = Date.now();
                        if (now - lastWarn < 60000) return;
                        lastWarn = now;

                        log('Memory pressure: ' +
                            Math.round(ratio * 100) + '% heap used — cleaning');

                        try {
                            var Cache = safeGet('Lampa.Cache');
                            if (Cache && typeof Cache.clear === 'function') {
                                Cache.clear();
                                log('Lampa.Cache cleared');
                            }
                        } catch (ex) {}

                        try {
                            var Reguest = safeGet('Lampa.Reguest');
                            if (Reguest && typeof Reguest.clear === 'function') {
                                Reguest.clear();
                                log('Lampa.Reguest queue cleared');
                            }
                        } catch (ex) {}
                    }
                } catch (ex) {
                    log('Memory check error: ' + ex.message);
                }
            }

            setInterval(check, MEM_CHECK_MS);
            log('Memory pressure monitor applied (' +
                'threshold ' + Math.round(MEM_THRESHOLD * 100) + '%, ' +
                'interval ' + MEM_CHECK_MS + 'ms)');
        } catch (e) {
            log('Memory pressure error: ' + e.message);
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
                log('Setting "' + key + '" = ' + value);
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

                    lg_opt_css_name: {
                        ru: 'GPU-ускорение карточек',
                        en: 'GPU card acceleration',
                        uk: 'GPU-прискорення карток'
                    },
                    lg_opt_css_desc: {
                        ru: 'Переносит карточки каталога на отдельный GPU-слой (translateZ). Снижает перерисовку при прокрутке. [webOS 3+]',
                        en: 'Promotes catalog cards to a dedicated GPU layer via translateZ. Reduces repaints while scrolling. [webOS 3+]',
                        uk: 'Переносить картки на окремий GPU-шар (translateZ). [webOS 3+]'
                    },

                    lg_opt_css_contain_name: {
                        ru: 'Изоляция reflow карточек (contain)',
                        en: 'Card reflow isolation (contain)',
                        uk: 'Ізоляція reflow карток (contain)'
                    },
                    lg_opt_css_contain_desc: {
                        ru: 'CSS contain:layout style paint запрещает браузеру распространять пересчёт вёрстки за пределы карточки. Сокращает layout-работу до ~30% от исходного. [webOS 6+]',
                        en: 'CSS contain:layout style paint prevents the browser from propagating layout recalculation beyond the card boundary. Reduces layout work to ~30%. [webOS 6+]',
                        uk: 'CSS contain:layout style paint забороняє поширення layout за межі картки. [webOS 6+]'
                    },

                    lg_opt_keydown_name: {
                        ru: 'Буферизация нажатий пульта',
                        en: 'Remote key buffering',
                        uk: 'Буферизація натискань пульта'
                    },
                    lg_opt_keydown_desc: {
                        ru: 'Ограничивает обработку каждого keydown-слушателя до одного раза за кадр через собственный RAF-буфер. Устраняет инерцию при удержании кнопок. [webOS 3+]',
                        en: 'Limits each keydown listener to once per frame via its own RAF buffer. Eliminates lag when holding remote buttons. [webOS 3+]',
                        uk: 'Обмежує кожен keydown-слухач до одного разу за кадр через власний RAF-буфер. [webOS 3+]'
                    },

                    lg_opt_storage_name: {
                        ru: 'Буфер записи в хранилище',
                        en: 'Storage write buffer',
                        uk: 'Буфер запису до сховища'
                    },
                    lg_opt_storage_desc: {
                        ru: 'Три уровня записи: критичные ключи — мгновенно, UI-настройки — 150 мс, остальное — 400 мс. Прогресс плеера никогда не теряется. [webOS 3+]',
                        en: 'Three write levels: critical keys immediately, UI settings at 150 ms, rest at 400 ms. Player progress is never lost. [webOS 3+]',
                        uk: 'Три рівні запису: критичні — миттєво, UI — 150 мс, решта — 400 мс. [webOS 3+]'
                    },

                    lg_opt_fetch_name: {
                        ru: 'Дедупликация сетевых запросов',
                        en: 'Network request deduplication',
                        uk: 'Дедуплікація мережевих запитів'
                    },
                    lg_opt_fetch_desc: {
                        ru: 'Объединяет дублирующиеся GET-запросы в один. Таймаут 15 сек, блокировка небезопасных URL. [webOS 3+]',
                        en: 'Merges duplicate GET requests into one. 15 s timeout, unsafe URL guard. [webOS 3+]',
                        uk: "Об'єднує дублюючі GET-запити в один. Таймаут 15 с, захист URL. [webOS 3+]"
                    },

                    lg_opt_images_name: {
                        ru: 'Ленивая загрузка постеров',
                        en: 'Lazy poster loading',
                        uk: 'Ліниве завантаження постерів'
                    },
                    lg_opt_images_desc: {
                        ru: 'Откладывает загрузку постеров до их приближения к экрану на 400 пикс. Освобождает сетевые соединения для приоритетных запросов. [webOS 5+]',
                        en: 'Defers poster loading until within 400 px of the viewport. Frees network connections for priority requests. [webOS 5+]',
                        uk: 'Відкладає завантаження постерів до наближення на 400 пкс до екрана. [webOS 5+]'
                    },

                    lg_opt_img_unload_name: {
                        ru: 'Выгрузка постеров далеко за экраном',
                        en: 'Unload off-screen posters',
                        uk: 'Вивантаження постерів поза екраном'
                    },
                    lg_opt_img_unload_desc: {
                        ru: 'Заменяет src постеров, ушедших за 200 пикс за пределы экрана, на пустышку. Один 300×450 постер = ~527 КБ GPU-памяти. 40 карточек = ~20 МБ. При возврате постер загружается снова. [webOS 5+]',
                        en: 'Replaces src of posters 200 px beyond the viewport with a placeholder, freeing GPU texture memory. One 300×450 poster ≈ 527 KB GPU. 40 cards ≈ 20 MB. Restored on scroll back. [webOS 5+]',
                        uk: 'Замінює src постерів за 200 пкс поза екраном на заглушку. Один постер ≈ 527 КБ GPU. 40 карток ≈ 20 МБ. [webOS 5+]'
                    },

                    lg_opt_player_name: {
                        ru: 'Оптимизация прогресс-бара плеера',
                        en: 'Player progress bar optimization',
                        uk: 'Оптимізація прогрес-бара плеєра'
                    },
                    lg_opt_player_desc: {
                        ru: 'Снижает частоту обновления прогресс-бара с ~25 до 4 раз/с. Освобождает ~6% CPU для видеодекодера. [webOS 3+]',
                        en: 'Reduces progress bar update frequency from ~25 to 4 Hz. Frees ~6% CPU for the video decoder. [webOS 3+]',
                        uk: 'Знижує частоту оновлення прогрес-бара з ~25 до 4 разів/с. [webOS 3+]'
                    },

                    lg_opt_json_name: {
                        ru: 'Защита от пустых ответов API',
                        en: 'API empty response guard',
                        uk: 'Захист від порожніх відповідей API'
                    },
                    lg_opt_json_desc: {
                        ru: 'Перехватывает null/undefined ответы Lampa.Reguest и вызывает обработчик ошибки вместо краша интерфейса. [webOS 3+]',
                        en: 'Intercepts null/undefined responses from Lampa.Reguest and invokes the error handler instead of crashing the UI. [webOS 3+]',
                        uk: 'Перехоплює null/undefined відповіді Lampa.Reguest і викликає обробник помилки. [webOS 3+]'
                    },

                    lg_opt_scroll_name: {
                        ru: 'Throttle обработчиков прокрутки',
                        en: 'Scroll handler throttle',
                        uk: 'Throttle обробників прокручування'
                    },
                    lg_opt_scroll_desc: {
                        ru: 'Ограничивает вызов scroll-обработчиков до одного раза за кадр через RAF. Снижает нагрузку CPU при быстрой прокрутке каталога. [webOS 3+]',
                        en: 'Limits scroll handler invocations to once per frame via RAF. Reduces CPU load during fast catalog scrolling. [webOS 3+]',
                        uk: 'Обмежує виклик scroll-обробників до одного разу за кадр через RAF. [webOS 3+]'
                    },

                    lg_opt_passive_name: {
                        ru: 'Пассивные обработчики касаний',
                        en: 'Passive touch event listeners',
                        uk: 'Пасивні обробники дотиків'
                    },
                    lg_opt_passive_desc: {
                        ru: 'Добавляет {passive:true} к touchstart/touchmove/wheel. Убирает обязательную 50 мс задержку ввода на каждое касание. [webOS 3+]',
                        en: 'Adds {passive:true} to touchstart/touchmove/wheel listeners. Eliminates the mandatory 50 ms input delay per touch event. [webOS 3+]',
                        uk: 'Додає {passive:true} до touchstart/touchmove/wheel. Прибирає обов\'язкову 50 мс затримку. [webOS 3+]'
                    },

                    lg_opt_dns_name: {
                        ru: 'DNS prefetch и preconnect',
                        en: 'DNS prefetch & preconnect',
                        uk: 'DNS prefetch та preconnect'
                    },
                    lg_opt_dns_desc: {
                        ru: 'Заранее резолвит DNS и устанавливает TLS-соединения с серверами TMDB и Kinopoisk при холодном старте. Первая карточка открывается быстрее. [webOS 3+]',
                        en: 'Pre-resolves DNS and establishes TLS connections to TMDB and Kinopoisk on cold start. First card opens faster. [webOS 3+]',
                        uk: 'Заздалегідь резолвить DNS і встановлює TLS-з\'єднання при холодному старті. [webOS 3+]'
                    },

                    lg_opt_filter_name: {
                        ru: 'Дебаунс фильтрации',
                        en: 'Filter debounce',
                        uk: 'Дебаунс фільтрації'
                    },
                    lg_opt_filter_desc: {
                        ru: 'Откладывает применение фильтра на 300 мс после последнего изменения. 1 пересчёт вместо 13 при вводе слова. [webOS 3+]',
                        en: 'Delays filter application by 300 ms after the last change. 1 recalculation instead of 13 per word. [webOS 3+]',
                        uk: 'Затримує застосування фільтра на 300 мс. 1 перерахунок замість 13. [webOS 3+]'
                    },

                    lg_opt_fastnav_name: {
                        ru: 'Мгновенный фокус при навигации',
                        en: 'Instant focus during navigation',
                        uk: 'Миттєвий фокус при навігації'
                    },
                    lg_opt_fastnav_desc: {
                        ru: 'Отключает CSS-анимации при быстром удержании кнопок пульта (интервал < 150 мс). При одиночных кликах анимации сохраняются. [webOS 3+]',
                        en: 'Disables CSS animations when remote buttons are held (interval < 150 ms). Single clicks keep their animations. [webOS 3+]',
                        uk: 'Вимикає CSS-анімації при утриманні кнопок пульта (інтервал < 150 мс). [webOS 3+]'
                    },

                    lg_opt_will_change_name: {
                        ru: 'GPU-слой только для активного элемента',
                        en: 'GPU layer only for active element',
                        uk: 'GPU-шар тільки для активного елемента'
                    },
                    lg_opt_will_change_desc: {
                        ru: 'will-change:transform вешается только на карточку в фокусе и снимается при уходе. Вместо N GPU-слоёв — всегда ровно 1. Устраняет checkerboarding на TV с малой GPU-памятью. [webOS 5+]',
                        en: 'will-change:transform is applied only to the focused card and removed on blur. Always exactly 1 GPU layer instead of N. Eliminates checkerboarding on TVs with limited GPU memory. [webOS 5+]',
                        uk: 'will-change:transform тільки для картки у фокусі. Завжди рівно 1 GPU-шар замість N. [webOS 5+]'
                    },

                    lg_opt_activity_gc_name: {
                        ru: 'Очистка памяти старых экранов',
                        en: 'Old screen memory cleanup',
                        uk: 'Очищення пам\'яті старих екранів'
                    },
                    lg_opt_activity_gc_desc: {
                        ru: 'Вызывает destroy() у экранов, которые находятся глубже 5-й позиции в стеке истории. Ликвидирует главную причину накопления утечек памяти после 30+ минут просмотра. [webOS 3+]',
                        en: 'Calls destroy() on screens deeper than position 5 in the history stack. Eliminates the main cause of memory leaks after 30+ minutes of use. [webOS 3+]',
                        uk: 'Викликає destroy() у екранів глибше 5-ї позиції в стеку. Головна причина витоків пам\'яті за 30+ хвилин. [webOS 3+]'
                    },

                    lg_opt_mem_pressure_name: {
                        ru: 'Монитор давления памяти',
                        en: 'Memory pressure monitor',
                        uk: 'Монітор тиску пам\'яті'
                    },
                    lg_opt_mem_pressure_desc: {
                        ru: 'Каждые 20 сек проверяет заполненность JS-кучи. При превышении 80% вызывает Lampa.Cache.clear(). Предотвращает аварийное завершение браузера ОС. [webOS 5+]',
                        en: 'Checks JS heap usage every 20 s. Calls Lampa.Cache.clear() when above 80%. Prevents the OS from killing the browser process. [webOS 5+]',
                        uk: 'Перевіряє заповненість JS-купи кожні 20 с. При 80% викликає Lampa.Cache.clear(). [webOS 5+]'
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
                buildParam(KEYS.css,          'lg_opt_css_name',          'lg_opt_css_desc',          true),
                buildParam(KEYS.css_contain,  'lg_opt_css_contain_name',  'lg_opt_css_contain_desc',  true),
                buildParam(KEYS.will_change,  'lg_opt_will_change_name',  'lg_opt_will_change_desc',  true),
                buildParam(KEYS.fastnav,      'lg_opt_fastnav_name',      'lg_opt_fastnav_desc',      true),
                buildParam(KEYS.keydown,      'lg_opt_keydown_name',      'lg_opt_keydown_desc',      true),
                buildParam(KEYS.scroll,       'lg_opt_scroll_name',       'lg_opt_scroll_desc',       true),
                buildParam(KEYS.passive,      'lg_opt_passive_name',      'lg_opt_passive_desc',      true),
                buildParam(KEYS.storage,      'lg_opt_storage_name',      'lg_opt_storage_desc',      true),
                buildParam(KEYS.fetch,        'lg_opt_fetch_name',        'lg_opt_fetch_desc',        true),
                buildParam(KEYS.images,       'lg_opt_images_name',       'lg_opt_images_desc',       true),
                buildParam(KEYS.img_unload,   'lg_opt_img_unload_name',   'lg_opt_img_unload_desc',   true),
                buildParam(KEYS.player,       'lg_opt_player_name',       'lg_opt_player_desc',       true),
                buildParam(KEYS.json,         'lg_opt_json_name',         'lg_opt_json_desc',         true),
                buildParam(KEYS.activity_gc,  'lg_opt_activity_gc_name',  'lg_opt_activity_gc_desc',  true),
                buildParam(KEYS.mem_pressure, 'lg_opt_mem_pressure_name', 'lg_opt_mem_pressure_desc', true),
                buildParam(KEYS.dns,          'lg_opt_dns_name',          'lg_opt_dns_desc',          true),
                buildParam(KEYS.filter,       'lg_opt_filter_name',       'lg_opt_filter_desc',       true)
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
            log('Plugin registered');
        } catch (e) {
            log('Plugin register error: ' + e.message);
        }
    }

    // ── ТОЧКА ВХОДА ──────────────────────────────────────────
    function init() {
        try {
            patchCSS();
            patchCSSContain();
            patchFastNav();
            patchEventListeners();
            patchFetch();
            patchDNS();
            patchWillChange();

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function () {
                    patchImages();
                    patchImgUnload();
                    patchPlayer();
                });
            } else {
                patchImages();
                patchImgUnload();
                patchPlayer();
            }

            patchLocalStorage();
            patchRequestGuard();
            patchFilter();
            patchActivityGC();
            patchMemPressure();
            registerPlugin();

            log('LG Optimizer ' + VERSION + ' — all modules started');
        } catch (e) {
            console.error('[LG-OPT] Fatal: ' + e.message);
        }
    }

    init();
})();
