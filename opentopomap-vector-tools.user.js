// ==UserScript==
// @name         OpenTopoMap Vector – saját beállítások
// @namespace    local.opentopomap
// @version      2.2
// @description  Feliratméret, szintvonal-vastagság és -szín, valamint opcionális OSM csúcs/nyereg nevek
// @match        https://www.opentopomap.org/vector/*
// @match        https://opentopomap.org/vector/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      overpass.private.coffee
// @connect      maps.mail.ru
// @connect      overpass-api.de
// ==/UserScript==

(() => {
    'use strict';

    const W =
        typeof unsafeWindow !== 'undefined'
            ? unsafeWindow
            : window;

    // ============================================================
    // BEÁLLÍTÁSOK
    // ============================================================

    const LABEL_KEY = 'otm-label-scale';
    const CONTOUR_KEY = 'otm-contour-scale';
    const CONTOUR_COLOR_KEY = 'otm-contour-color';

    const CACHE_DATA_KEY = 'otm-extra-cache-data-v2';
    const CACHE_BOUNDS_KEY = 'otm-extra-cache-bounds-v2';
    const CACHE_TIME_KEY = 'otm-extra-cache-time-v2';

    const CONTOUR_SCALE_VALUES = [1, 1.25, 1.5, 1.75, 2];

    const CONTOUR_COLORS = {
        original: {
            label: 'Eredeti',
            color: null
        },
        darkbrown: {
            label: 'Sötétbarna',
            color: '#6b3a1e'
        },
        darkgray: {
            label: 'Sötétszürke',
            color: '#444444'
        },
        black: {
            label: 'Fekete',
            color: '#000000'
        }
    };

    const EXTRA_MIN_ZOOM = 12;
    const CACHE_MAX_AGE = 6 * 60 * 60 * 1000;

    let labelScale =
        Number(localStorage.getItem(LABEL_KEY) || 1.5);

    // Régi vagy hibás tárolt értékek korlátozása 100–300%-ra.
    labelScale =
        Math.min(
            3,
            Math.max(
                1,
                Math.round(labelScale * 4) / 4
            )
        );

    let contourScale =
        Number(localStorage.getItem(CONTOUR_KEY) || 1.5);

    if (!CONTOUR_SCALE_VALUES.includes(contourScale)) {
        contourScale = 1.5;
    }

    let contourColor =
        localStorage.getItem(CONTOUR_COLOR_KEY) || 'original';

    if (!CONTOUR_COLORS[contourColor]) {
        contourColor = 'original';
    }

    // Minden oldalbetöltéskor kikapcsolva indul.
    let extraNamesOn = false;

    const OVERPASS_ENDPOINTS = [
        {
            name: 'Private.coffee',
            url: 'https://overpass.private.coffee/api/interpreter'
        },
        {
            name: 'VK Maps',
            url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        },
        {
            name: 'Overpass API',
            url: 'https://overpass-api.de/api/interpreter'
        }
    ];

    // ============================================================
    // BELSŐ ÁLLAPOT
    // ============================================================

    let capturedMap = null;

    const originalTextSizes = new Map();

    let originalContourWidth = null;
    let originalContourLineColor = null;
    let originalContourLabelColor = null;

    const EXTRA_SOURCE = 'otm-extra-relief-source';
    const EXTRA_PEAKS = 'otm-extra-relief-peaks';
    const EXTRA_SADDLES = 'otm-extra-relief-saddles';

    let fetchedBounds = null;
    let extraFeatureCount = 0;
    let extraStatusText = 'OSM-nevek: KI';

    let refreshTimer = null;
    let requestInFlight = false;
    let refreshQueued = false;
    let forceRefreshQueued = false;

    let extraRequestEpoch = 0;
    let activeRequest = null;

    // ============================================================
    // MAPLIBRE ELKAPÁSA
    // ============================================================

    let storedMapLibre;

    Object.defineProperty(
        W,
        'maplibregl',
        {
            configurable: true,

            get() {
                return storedMapLibre;
            },

            set(lib) {
                storedMapLibre = lib;

                if (
                    !lib ||
                    !lib.Map ||
                    lib.__otmCustomPatched
                ) {
                    return;
                }

                lib.__otmCustomPatched = true;

                const OriginalMap = lib.Map;

                lib.Map = class extends OriginalMap {
                    constructor(options) {
                        super(options);

                        capturedMap = this;

                        this.on('load', () => {
                            rememberOriginalTextSizes();
                            rememberOriginalContourStyle();

                            applyLabelScale();
                            applyContourScale();
                            applyContourColor();

                            extraNamesOn = false;
                            extraStatusText = 'OSM-nevek: KI';

                            updateControls();
                            updateStatus();
                        });

                        this.on('moveend', () => {
                            if (extraNamesOn) {
                                scheduleRefresh(1200, false);
                            }
                        });
                    }
                };
            }
        }
    );

    // ============================================================
    // MAPLIBRE KIFEJEZÉSEK MÉRETEZÉSE
    // ============================================================

    function scaleExpression(expr, factor) {
        if (typeof expr === 'number') {
            return expr * factor;
        }

        if (!Array.isArray(expr)) {
            return expr;
        }

        const op = expr[0];

        if (op === 'interpolate') {
            const result = [
                expr[0],
                structuredClone(expr[1]),
                structuredClone(expr[2])
            ];

            for (let i = 3; i < expr.length; i += 2) {
                result.push(structuredClone(expr[i]));
                result.push(
                    scaleExpression(
                        expr[i + 1],
                        factor
                    )
                );
            }

            return result;
        }

        if (op === 'step') {
            const result = [
                expr[0],
                structuredClone(expr[1]),
                scaleExpression(expr[2], factor)
            ];

            for (let i = 3; i < expr.length; i += 2) {
                result.push(structuredClone(expr[i]));
                result.push(
                    scaleExpression(
                        expr[i + 1],
                        factor
                    )
                );
            }

            return result;
        }

        if (op === 'match') {
            const result = [
                expr[0],
                structuredClone(expr[1])
            ];

            const last = expr.length - 1;

            for (let i = 2; i < last; i += 2) {
                result.push(structuredClone(expr[i]));
                result.push(
                    scaleExpression(
                        expr[i + 1],
                        factor
                    )
                );
            }

            result.push(
                scaleExpression(
                    expr[last],
                    factor
                )
            );

            return result;
        }

        if (op === 'case') {
            const result = [expr[0]];
            const last = expr.length - 1;

            for (let i = 1; i < last; i += 2) {
                result.push(structuredClone(expr[i]));
                result.push(
                    scaleExpression(
                        expr[i + 1],
                        factor
                    )
                );
            }

            result.push(
                scaleExpression(
                    expr[last],
                    factor
                )
            );

            return result;
        }

        return [
            '*',
            factor,
            structuredClone(expr)
        ];
    }

    // ============================================================
    // FELIRATMÉRET
    // ============================================================

    function rememberOriginalTextSizes() {
        if (!capturedMap) return;

        const style = capturedMap.getStyle();
        if (!style?.layers) return;

        for (const layer of style.layers) {
            if (layer.type !== 'symbol') continue;

            if (
                layer.id === EXTRA_PEAKS ||
                layer.id === EXTRA_SADDLES
            ) {
                continue;
            }

            const field =
                capturedMap.getLayoutProperty(
                    layer.id,
                    'text-field'
                );

            if (field == null) continue;

            if (!originalTextSizes.has(layer.id)) {
                let size =
                    capturedMap.getLayoutProperty(
                        layer.id,
                        'text-size'
                    );

                if (size == null) {
                    size = 16;
                }

                originalTextSizes.set(
                    layer.id,
                    structuredClone(size)
                );
            }
        }
    }

    function applyLabelScale() {
        if (!capturedMap) return;

        rememberOriginalTextSizes();

        for (
            const [id, original]
            of originalTextSizes
        ) {
            try {
                if (!capturedMap.getLayer(id)) {
                    continue;
                }

                capturedMap.setLayoutProperty(
                    id,
                    'text-size',
                    scaleExpression(
                        original,
                        labelScale
                    )
                );

            } catch (e) {
                console.warn(
                    'Felirat:',
                    id,
                    e
                );
            }
        }

        applyExtraLabelScale();
        updateControls();
    }

    function applyExtraLabelScale() {
        if (!capturedMap) return;

        if (capturedMap.getLayer(EXTRA_PEAKS)) {
            capturedMap.setLayoutProperty(
                EXTRA_PEAKS,
                'text-size',
                11 * labelScale
            );
        }

        if (capturedMap.getLayer(EXTRA_SADDLES)) {
            capturedMap.setLayoutProperty(
                EXTRA_SADDLES,
                'text-size',
                10.5 * labelScale
            );
        }
    }

    // ============================================================
    // SZINTVONAL – EREDETI STÍLUS
    // ============================================================

    function rememberOriginalContourStyle() {
        if (!capturedMap) return;

        try {
            if (originalContourWidth === null) {
                const width =
                    capturedMap.getPaintProperty(
                        'contour-lines',
                        'line-width'
                    );

                if (width != null) {
                    originalContourWidth =
                        structuredClone(width);
                }
            }

            if (originalContourLineColor === null) {
                const lineColor =
                    capturedMap.getPaintProperty(
                        'contour-lines',
                        'line-color'
                    );

                if (lineColor != null) {
                    originalContourLineColor =
                        structuredClone(lineColor);
                }
            }

            if (originalContourLabelColor === null) {
                const labelColor =
                    capturedMap.getPaintProperty(
                        'contour-labels',
                        'text-color'
                    );

                if (labelColor != null) {
                    originalContourLabelColor =
                        structuredClone(labelColor);
                }
            }

        } catch (e) {
            console.warn(
                'Szintvonal eredeti stílusa:',
                e
            );
        }
    }

    // ============================================================
    // SZINTVONAL-VASTAGSÁG
    // ============================================================

    function applyContourScale() {
        if (!capturedMap) return;

        rememberOriginalContourStyle();

        if (originalContourWidth == null) {
            return;
        }

        try {
            if (capturedMap.getLayer('contour-lines')) {
                capturedMap.setPaintProperty(
                    'contour-lines',
                    'line-width',
                    scaleExpression(
                        originalContourWidth,
                        contourScale
                    )
                );
            }

        } catch (e) {
            console.warn(
                'Szintvonal-vastagság:',
                e
            );
        }

        updateControls();
    }

    // ============================================================
    // SZINTVONAL-SZÍN
    // ============================================================

    function applyContourColor() {
        if (!capturedMap) return;

        rememberOriginalContourStyle();

        try {
            let lineColor;
            let labelColor;

            if (contourColor === 'original') {
                lineColor =
                    originalContourLineColor;

                labelColor =
                    originalContourLabelColor;

            } else {
                const selected =
                    CONTOUR_COLORS[
                        contourColor
                    ]?.color;

                lineColor = selected;
                labelColor = selected;
            }

            if (
                lineColor != null &&
                capturedMap.getLayer(
                    'contour-lines'
                )
            ) {
                capturedMap.setPaintProperty(
                    'contour-lines',
                    'line-color',
                    structuredClone(lineColor)
                );
            }

            if (
                labelColor != null &&
                capturedMap.getLayer(
                    'contour-labels'
                )
            ) {
                capturedMap.setPaintProperty(
                    'contour-labels',
                    'text-color',
                    structuredClone(labelColor)
                );
            }

        } catch (e) {
            console.warn(
                'Szintvonal-szín:',
                e
            );
        }

        updateControls();
    }

    // ============================================================
    // KIEGÉSZÍTŐ OSM-RÉTEGEK
    // ============================================================

    function ensureExtraLayers() {
        if (!capturedMap) return;

        if (!capturedMap.getSource(EXTRA_SOURCE)) {
            capturedMap.addSource(
                EXTRA_SOURCE,
                {
                    type: 'geojson',
                    data: emptyFeatureCollection()
                }
            );
        }

        const commonLayout = {
            'symbol-placement': 'point',

            'text-font':
                ['Roboto Regular'],

            'text-variable-anchor': [
                'top',
                'bottom',
                'right',
                'left',
                'top-right',
                'top-left',
                'bottom-right',
                'bottom-left'
            ],

            'text-radial-offset': 0.55,
            'text-justify': 'auto',
            'text-padding': 2,
            'text-allow-overlap': false
        };

        if (!capturedMap.getLayer(EXTRA_PEAKS)) {
            capturedMap.addLayer({
                id: EXTRA_PEAKS,
                type: 'symbol',
                source: EXTRA_SOURCE,
                minzoom: EXTRA_MIN_ZOOM,

                filter: [
                    '==',
                    ['get', 'type'],
                    'peak'
                ],

                layout: {
                    ...commonLayout,

                    'text-field': [
                        'case',
                        ['has', 'eleLabel'],
                        [
                            'concat',
                            ['get', 'name'],
                            '\n',
                            ['get', 'eleLabel']
                        ],
                        ['get', 'name']
                    ],

                    'text-size':
                        11 * labelScale
                },

                paint: {
                    'text-color': '#111',

                    'text-halo-color':
                        'rgba(255,255,255,0.95)',

                    'text-halo-width':
                        1.5
                }
            });
        }

        if (!capturedMap.getLayer(EXTRA_SADDLES)) {
            capturedMap.addLayer({
                id: EXTRA_SADDLES,
                type: 'symbol',
                source: EXTRA_SOURCE,
                minzoom: EXTRA_MIN_ZOOM,

                filter: [
                    '==',
                    ['get', 'type'],
                    'saddle'
                ],

                layout: {
                    ...commonLayout,

                    'text-field': [
                        'case',
                        ['has', 'eleLabel'],
                        [
                            'concat',
                            ['get', 'name'],
                            '\n',
                            ['get', 'eleLabel']
                        ],
                        ['get', 'name']
                    ],

                    'text-size':
                        10.5 * labelScale
                },

                paint: {
                    'text-color': '#222',

                    'text-halo-color':
                        'rgba(255,255,255,0.95)',

                    'text-halo-width':
                        1.5
                }
            });
        }
    }

    function removeExtraLayers() {
        if (!capturedMap) return;

        try {
            if (capturedMap.getLayer(EXTRA_PEAKS)) {
                capturedMap.removeLayer(EXTRA_PEAKS);
            }

            if (capturedMap.getLayer(EXTRA_SADDLES)) {
                capturedMap.removeLayer(EXTRA_SADDLES);
            }

            if (capturedMap.getSource(EXTRA_SOURCE)) {
                capturedMap.removeSource(EXTRA_SOURCE);
            }

        } catch (e) {
            console.warn(
                'OSM-réteg eltávolítása:',
                e
            );
        }
    }

    // ============================================================
    // BE / KI
    // ============================================================

    function enableExtraNames() {
        if (!capturedMap) return;

        if (extraNamesOn) {
            updateControls();
            return;
        }

        extraNamesOn = true;
        extraRequestEpoch++;

        ensureExtraLayers();
        applyExtraLabelScale();

        fetchedBounds = null;
        extraFeatureCount = 0;

        if (
            capturedMap.getZoom()
            < EXTRA_MIN_ZOOM
        ) {
            extraStatusText =
                `OSM-nevek: BE · ${EXTRA_MIN_ZOOM}-es zoomtól`;

            updateControls();
            updateStatus();
            return;
        }

        const cacheLoaded =
            loadCachedNamesForCurrentView();

        if (!cacheLoaded) {
            extraStatusText =
                'OSM-nevek: BE · lekérdezés indul…';
        }

        updateControls();
        updateStatus();

        // BE-kapcsoláskor mindig kérünk friss adatot is.
        scheduleRefresh(200, true);
    }

    function disableExtraNames() {
        extraNamesOn = false;
        extraRequestEpoch++;

        clearTimeout(refreshTimer);
        refreshTimer = null;

        refreshQueued = false;
        forceRefreshQueued = false;

        if (
            activeRequest &&
            typeof activeRequest.abort === 'function'
        ) {
            try {
                activeRequest.abort();
            } catch (_) {
            }
        }

        activeRequest = null;
        requestInFlight = false;

        fetchedBounds = null;
        extraFeatureCount = 0;

        removeExtraLayers();

        extraStatusText =
            'OSM-nevek: KI';

        updateControls();
        updateStatus();
    }

    // ============================================================
    // CACHE – CSAK BEKAPCSOLT ÁLLAPOTBAN
    // ============================================================

    function loadCachedNamesForCurrentView() {
        if (
            !extraNamesOn ||
            !capturedMap ||
            capturedMap.getZoom()
                < EXTRA_MIN_ZOOM
        ) {
            return false;
        }

        try {
            const time =
                Number(
                    localStorage.getItem(
                        CACHE_TIME_KEY
                    ) || 0
                );

            if (
                !time ||
                Date.now() - time >
                    CACHE_MAX_AGE
            ) {
                return false;
            }

            const dataText =
                localStorage.getItem(
                    CACHE_DATA_KEY
                );

            const boundsText =
                localStorage.getItem(
                    CACHE_BOUNDS_KEY
                );

            if (
                !dataText ||
                !boundsText
            ) {
                return false;
            }

            const data =
                JSON.parse(dataText);

            const bounds =
                JSON.parse(boundsText);

            const view =
                capturedMap.getBounds();

            if (
                !boundsContain(
                    bounds,
                    view
                )
            ) {
                return false;
            }

            ensureExtraLayers();
            setExtraData(data);

            fetchedBounds = bounds;

            extraFeatureCount =
                data.features?.length || 0;

            extraStatusText =
                `OSM-nevek: BE · ${extraFeatureCount} gyorsítótárból`;

            return true;

        } catch (e) {
            console.warn(
                'Cache:',
                e
            );

            return false;
        }
    }

    function saveCache(data, bounds) {
        try {
            localStorage.setItem(
                CACHE_DATA_KEY,
                JSON.stringify(data)
            );

            localStorage.setItem(
                CACHE_BOUNDS_KEY,
                JSON.stringify(bounds)
            );

            localStorage.setItem(
                CACHE_TIME_KEY,
                String(Date.now())
            );

        } catch (e) {
            console.warn(
                'Cache mentés:',
                e
            );
        }
    }

    // ============================================================
    // FRISSÍTÉS IDŐZÍTÉSE
    // ============================================================

    function scheduleRefresh(
        delay = 1200,
        force = false
    ) {
        if (!extraNamesOn) return;

        clearTimeout(refreshTimer);

        refreshTimer =
            setTimeout(
                () => {
                    if (!extraNamesOn) {
                        return;
                    }

                    if (requestInFlight) {
                        refreshQueued = true;

                        forceRefreshQueued =
                            forceRefreshQueued ||
                            force;

                        return;
                    }

                    refreshNames(force);
                },
                delay
            );
    }

    function manualRefresh() {
        if (!extraNamesOn) return;

        fetchedBounds = null;

        extraStatusText =
            'OSM-nevek: kézi frissítés…';

        updateStatus();

        scheduleRefresh(
            50,
            true
        );
    }

    // ============================================================
    // OSM NEVEK FRISSÍTÉSE
    // ============================================================

    async function refreshNames(
        force = false
    ) {
        if (
            !capturedMap ||
            !extraNamesOn
        ) {
            return;
        }

        if (requestInFlight) {
            refreshQueued = true;

            forceRefreshQueued =
                forceRefreshQueued ||
                force;

            return;
        }

        if (
            capturedMap.getZoom()
            < EXTRA_MIN_ZOOM
        ) {
            extraStatusText =
                `OSM-nevek: BE · ${EXTRA_MIN_ZOOM}-es zoomtól`;

            updateStatus();
            return;
        }

        const view =
            capturedMap.getBounds();

        if (
            !force &&
            fetchedBounds &&
            boundsContain(
                fetchedBounds,
                view
            )
        ) {
            extraStatusText =
                `OSM-nevek: BE · ${extraFeatureCount} betöltve`;

            updateStatus();
            return;
        }

        const queryBounds =
            paddedBounds(
                view,
                0.35
            );

        const myEpoch =
            extraRequestEpoch;

        requestInFlight = true;
        refreshQueued = false;
        forceRefreshQueued = false;

        extraStatusText =
            extraFeatureCount > 0
                ? `OSM-nevek: frissítés… (${extraFeatureCount} név megmarad)`
                : 'OSM-nevek: betöltés…';

        updateStatus();

        try {
            const query =
                buildQuery(
                    queryBounds
                );

            const result =
                await queryOverpass(
                    query,
                    myEpoch
                );

            if (
                !extraNamesOn ||
                myEpoch !==
                    extraRequestEpoch
            ) {
                return;
            }

            const renderedNames =
                getRenderedOtmNames();

            const features = [];

            for (
                const element
                of result.data.elements || []
            ) {
                if (
                    element.type !== 'node'
                ) {
                    continue;
                }

                const tags =
                    element.tags || {};

                const name =
                    String(
                        tags.name || ''
                    ).trim();

                const type =
                    tags.natural;

                if (
                    !name ||
                    (
                        type !== 'peak' &&
                        type !== 'saddle'
                    )
                ) {
                    continue;
                }

                if (
                    renderedNames.has(
                        normalizeName(name)
                    )
                ) {
                    continue;
                }

                const properties = {
                    name,
                    type,
                    osmId:
                        element.id
                };

                const elevation =
                    formatElevation(
                        tags.ele
                    );

                if (elevation) {
                    properties.eleLabel =
                        elevation;
                }

                features.push({
                    type: 'Feature',

                    geometry: {
                        type: 'Point',

                        coordinates: [
                            element.lon,
                            element.lat
                        ]
                    },

                    properties
                });
            }

            const collection = {
                type: 'FeatureCollection',
                features
            };

            if (
                !extraNamesOn ||
                myEpoch !==
                    extraRequestEpoch
            ) {
                return;
            }

            ensureExtraLayers();
            setExtraData(collection);

            fetchedBounds =
                queryBounds;

            extraFeatureCount =
                features.length;

            extraStatusText =
                `OSM-nevek: BE · ${extraFeatureCount} betöltve · ${result.server}`;

            saveCache(
                collection,
                queryBounds
            );

        } catch (e) {
            if (
                !extraNamesOn ||
                myEpoch !==
                    extraRequestEpoch
            ) {
                return;
            }

            console.error(
                'Overpass hiba:',
                e
            );

            extraStatusText =
                extraFeatureCount > 0
                    ? `OSM-nevek: frissítési hiba · ${extraFeatureCount} korábbi név maradt`
                    : `OSM-nevek: lekérdezési hiba · ${e.message || e}`;

        } finally {
            if (
                myEpoch ===
                    extraRequestEpoch
            ) {
                requestInFlight = false;
                activeRequest = null;

                updateStatus();

                if (
                    extraNamesOn &&
                    refreshQueued
                ) {
                    const queuedForce =
                        forceRefreshQueued;

                    refreshQueued = false;
                    forceRefreshQueued = false;

                    scheduleRefresh(
                        700,
                        queuedForce
                    );
                }
            }
        }
    }

    // ============================================================
    // OVERPASS – VIOLENTMONKEY HÁLÓZATI KÉRÉS
    // ============================================================

    async function queryOverpass(
        query,
        epoch
    ) {
        let lastError = null;

        for (
            const server
            of OVERPASS_ENDPOINTS
        ) {
            if (
                !extraNamesOn ||
                epoch !==
                    extraRequestEpoch
            ) {
                throw new Error(
                    'megszakítva'
                );
            }

            extraStatusText =
                `OSM-nevek: ${server.name}…`;

            updateStatus();

            try {
                const response =
                    await gmPost(
                        server.url,
                        query,
                        epoch
                    );

                const data =
                    JSON.parse(
                        response.responseText
                    );

                return {
                    server:
                        server.name,

                    data
                };

            } catch (e) {
                if (
                    !extraNamesOn ||
                    epoch !==
                        extraRequestEpoch
                ) {
                    throw e;
                }

                console.warn(
                    server.name,
                    e
                );

                lastError = e;
            }
        }

        throw (
            lastError ||
            new Error(
                'egyik Overpass szerver sem válaszolt'
            )
        );
    }

    function gmPost(
        url,
        query,
        epoch
    ) {
        return new Promise(
            (resolve, reject) => {

                if (
                    !extraNamesOn ||
                    epoch !==
                        extraRequestEpoch
                ) {
                    reject(
                        new Error(
                            'megszakítva'
                        )
                    );

                    return;
                }

                let settled = false;

                const request =
                    GM_xmlhttpRequest({
                        method:
                            'POST',

                        url,

                        headers: {
                            'Content-Type':
                                'application/x-www-form-urlencoded;charset=UTF-8'
                        },

                        data:
                            'data=' +
                            encodeURIComponent(
                                query
                            ),

                        timeout:
                            20000,

                        onload(response) {
                            if (settled) return;
                            settled = true;

                            if (
                                response.status >= 200 &&
                                response.status < 300
                            ) {
                                resolve(response);

                            } else {
                                reject(
                                    new Error(
                                        `HTTP ${response.status}`
                                    )
                                );
                            }
                        },

                        ontimeout() {
                            if (settled) return;
                            settled = true;

                            reject(
                                new Error(
                                    'időtúllépés'
                                )
                            );
                        },

                        onerror() {
                            if (settled) return;
                            settled = true;

                            reject(
                                new Error(
                                    'hálózati hiba'
                                )
                            );
                        },

                        onabort() {
                            if (settled) return;
                            settled = true;

                            reject(
                                new Error(
                                    'megszakítva'
                                )
                            );
                        }
                    });

                activeRequest =
                    request;
            }
        );
    }

    // ============================================================
    // OVERPASS LEKÉRDEZÉS
    // ============================================================

    function buildQuery(b) {
        const south =
            b.south.toFixed(6);

        const west =
            b.west.toFixed(6);

        const north =
            b.north.toFixed(6);

        const east =
            b.east.toFixed(6);

        return `
[out:json][timeout:15];
(
  node["natural"="peak"]["name"](${south},${west},${north},${east});
  node["natural"="saddle"]["name"](${south},${west},${north},${east});
);
out body;
        `.trim();
    }

    // ============================================================
    // DUPLIKÁCIÓK KISZŰRÉSE
    // ============================================================

    function getRenderedOtmNames() {
        const names = new Set();

        if (
            !capturedMap ||
            !capturedMap.getLayer(
                'poi-texts'
            )
        ) {
            return names;
        }

        try {
            const features =
                capturedMap.queryRenderedFeatures(
                    undefined,
                    {
                        layers:
                            ['poi-texts']
                    }
                );

            for (
                const feature
                of features
            ) {
                const name =
                    feature.properties?.name;

                if (name) {
                    names.add(
                        normalizeName(name)
                    );
                }
            }

        } catch (e) {
            console.warn(
                'Duplikációszűrés:',
                e
            );
        }

        return names;
    }

    function normalizeName(name) {
        return String(name)
            .trim()
            .toLocaleLowerCase(
                'hu-HU'
            );
    }

    // ============================================================
    // MAGASSÁG
    // ============================================================

    function formatElevation(ele) {
        if (ele == null) {
            return '';
        }

        const text =
            String(ele).trim();

        if (!text) {
            return '';
        }

        if (
            /^-?\d+(?:[.,]\d+)?$/
                .test(text)
        ) {
            return `${text} m`;
        }

        return text;
    }

    // ============================================================
    // GEOJSON
    // ============================================================

    function setExtraData(data) {
        if (!extraNamesOn) return;

        const source =
            capturedMap?.getSource(
                EXTRA_SOURCE
            );

        if (source?.setData) {
            source.setData(data);
        }
    }

    function emptyFeatureCollection() {
        return {
            type:
                'FeatureCollection',

            features:
                []
        };
    }

    // ============================================================
    // TERÜLETHATÁROK
    // ============================================================

    function paddedBounds(
        bounds,
        fraction
    ) {
        const west =
            bounds.getWest();

        const east =
            bounds.getEast();

        const south =
            bounds.getSouth();

        const north =
            bounds.getNorth();

        const dx =
            (east - west) *
            fraction;

        const dy =
            (north - south) *
            fraction;

        return {
            west:
                Math.max(
                    -180,
                    west - dx
                ),

            east:
                Math.min(
                    180,
                    east + dx
                ),

            south:
                Math.max(
                    -90,
                    south - dy
                ),

            north:
                Math.min(
                    90,
                    north + dy
                )
        };
    }

    function boundsContain(
        outer,
        inner
    ) {
        return (
            inner.getWest()
                >= outer.west &&

            inner.getEast()
                <= outer.east &&

            inner.getSouth()
                >= outer.south &&

            inner.getNorth()
                <= outer.north
        );
    }

    // ============================================================
    // KEZELŐPANEL
    // ============================================================

    function makePanel() {
        if (!document.body) {
            setTimeout(
                makePanel,
                50
            );
            return;
        }

        if (
            document.getElementById(
                'otm-control-panel'
            )
        ) {
            return;
        }

        const panel =
            document.createElement(
                'div'
            );

        panel.id =
            'otm-control-panel';

        Object.assign(
            panel.style,
            {
                position: 'fixed',
                top: '12px',
                right: '12px',
                zIndex: '999999',

                width: '285px',

                background:
                    'rgba(255,255,255,.96)',

                border:
                    '1px solid #888',

                borderRadius:
                    '8px',

                boxShadow:
                    '0 2px 8px rgba(0,0,0,.25)',

                font:
                    '13px Arial,sans-serif',

                color:
                    '#000',

                overflow:
                    'hidden'
            }
        );

        // --------------------------------------------------------
        // FEJLÉC + ÖSSZECSUKÁS
        // --------------------------------------------------------

        const header =
            document.createElement(
                'div'
            );

        Object.assign(
            header.style,
            {
                display:
                    'flex',

                alignItems:
                    'center',

                justifyContent:
                    'space-between',

                gap:
                    '10px',

                padding:
                    '8px 9px',

                fontWeight:
                    'bold',

                cursor:
                    'pointer',

                userSelect:
                    'none',

                background:
                    '#f1f1f1'
            }
        );

        const headerTitle =
            document.createElement(
                'span'
            );

        headerTitle.textContent =
            'OpenTopoMap beállítások';

        const collapseButton =
            document.createElement(
                'button'
            );

        collapseButton.type =
            'button';

        collapseButton.textContent =
            '▲';

        collapseButton.title =
            'Panel összecsukása';

        Object.assign(
            collapseButton.style,
            {
                border:
                    'none',

                background:
                    'transparent',

                padding:
                    '1px 4px',

                fontSize:
                    '14px',

                cursor:
                    'pointer'
            }
        );

        header.appendChild(
            headerTitle
        );

        header.appendChild(
            collapseButton
        );

        panel.appendChild(header);

        const body =
            document.createElement(
                'div'
            );

        body.id =
            'otm-control-body';

        body.style.padding =
            '9px';

        panel.appendChild(body);

        let collapsed = false;

        function togglePanel() {
            collapsed =
                !collapsed;

            body.style.display =
                collapsed
                    ? 'none'
                    : 'block';

            collapseButton.textContent =
                collapsed
                    ? '▼'
                    : '▲';

            collapseButton.title =
                collapsed
                    ? 'Panel kinyitása'
                    : 'Panel összecsukása';
        }

        header.onclick =
            togglePanel;

        collapseButton.onclick =
            event => {
                event.stopPropagation();
                togglePanel();
            };

        // --------------------------------------------------------
        // FELIRATMÉRET – CSÚSZKA
        // --------------------------------------------------------

        const labelTitle =
            sectionTitle(
                'Feliratméret'
            );

        body.appendChild(
            labelTitle
        );

        const sliderRow =
            document.createElement(
                'div'
            );

        Object.assign(
            sliderRow.style,
            {
                display:
                    'flex',

                alignItems:
                    'center',

                gap:
                    '8px'
            }
        );

        const slider =
            document.createElement(
                'input'
            );

        slider.id =
            'otm-label-slider';

        slider.type =
            'range';

        slider.min =
            '100';

        slider.max =
            '300';

        slider.step =
            '25';

        slider.value =
            String(
                Math.round(
                    labelScale * 100
                )
            );

        Object.assign(
            slider.style,
            {
                flex:
                    '1',

                minWidth:
                    '0'
            }
        );

        const labelValue =
            document.createElement(
                'span'
            );

        labelValue.id =
            'otm-label-value';

        labelValue.textContent =
            `${Math.round(
                labelScale * 100
            )}%`;

        Object.assign(
            labelValue.style,
            {
                width:
                    '45px',

                textAlign:
                    'right',

                fontWeight:
                    'bold'
            }
        );

        slider.oninput =
            () => {
                labelScale =
                    Number(
                        slider.value
                    ) / 100;

                localStorage.setItem(
                    LABEL_KEY,
                    String(labelScale)
                );

                labelValue.textContent =
                    `${slider.value}%`;

                applyLabelScale();
            };

        sliderRow.appendChild(
            slider
        );

        sliderRow.appendChild(
            labelValue
        );

        body.appendChild(
            sliderRow
        );

        const sliderLimits =
            document.createElement(
                'div'
            );

        Object.assign(
            sliderLimits.style,
            {
                display:
                    'flex',

                justifyContent:
                    'space-between',

                marginTop:
                    '-2px',

                marginRight:
                    '53px',

                fontSize:
                    '10px',

                color:
                    '#777'
            }
        );

        sliderLimits.innerHTML =
            '<span>100%</span><span>300%</span>';

        body.appendChild(
            sliderLimits
        );

        // --------------------------------------------------------
        // SZINTVONAL-VASTAGSÁG
        // --------------------------------------------------------

        body.appendChild(
            sectionTitle(
                'Szintvonal'
            )
        );

        const thicknessLabel =
            smallLabel(
                'Vastagság'
            );

        body.appendChild(
            thicknessLabel
        );

        const contourButtons =
            document.createElement(
                'div'
            );

        contourButtons.style.whiteSpace =
            'nowrap';

        for (
            const value
            of CONTOUR_SCALE_VALUES
        ) {
            const button =
                document.createElement(
                    'button'
                );

            button.textContent =
                `${Math.round(
                    value * 100
                )}%`;

            button.dataset.contourScale =
                String(value);

            Object.assign(
                button.style,
                buttonStyle()
            );

            button.onclick =
                () => {
                    contourScale =
                        value;

                    localStorage.setItem(
                        CONTOUR_KEY,
                        String(value)
                    );

                    applyContourScale();
                };

            contourButtons.appendChild(
                button
            );
        }

        body.appendChild(
            contourButtons
        );

        // --------------------------------------------------------
        // SZINTVONAL-SZÍN
        // --------------------------------------------------------

        const colorRow =
            document.createElement(
                'div'
            );

        Object.assign(
            colorRow.style,
            {
                display:
                    'flex',

                alignItems:
                    'center',

                gap:
                    '8px',

                marginTop:
                    '7px'
            }
        );

        const colorLabel =
            document.createElement(
                'span'
            );

        colorLabel.textContent =
            'Szín';

        colorLabel.style.fontSize =
            '12px';

        const colorSelect =
            document.createElement(
                'select'
            );

        colorSelect.id =
            'otm-contour-color';

        Object.assign(
            colorSelect.style,
            {
                flex:
                    '1',

                padding:
                    '4px 5px',

                border:
                    '1px solid #888',

                borderRadius:
                    '5px',

                background:
                    '#fff',

                color:
                    '#000'
            }
        );

        for (
            const [key, option]
            of Object.entries(
                CONTOUR_COLORS
            )
        ) {
            const element =
                document.createElement(
                    'option'
                );

            element.value =
                key;

            element.textContent =
                option.label;

            colorSelect.appendChild(
                element
            );
        }

        colorSelect.value =
            contourColor;

        colorSelect.onchange =
            () => {
                contourColor =
                    colorSelect.value;

                localStorage.setItem(
                    CONTOUR_COLOR_KEY,
                    contourColor
                );

                applyContourColor();
            };

        colorRow.appendChild(
            colorLabel
        );

        colorRow.appendChild(
            colorSelect
        );

        body.appendChild(
            colorRow
        );

        const colorHint =
            document.createElement(
                'div'
            );

        colorHint.textContent =
            'A magasságszámok színe is követi a szintvonalét.';

        Object.assign(
            colorHint.style,
            {
                marginTop:
                    '4px',

                fontSize:
                    '10px',

                color:
                    '#666'
            }
        );

        body.appendChild(
            colorHint
        );

        // --------------------------------------------------------
        // DOMBORZATI NEVEK
        // --------------------------------------------------------

        body.appendChild(
            sectionTitle(
                'Domborzati nevek'
            )
        );

        const extraButtons =
            document.createElement(
                'div'
            );

        const onButton =
            document.createElement(
                'button'
            );

        onButton.textContent =
            'BE';

        onButton.dataset.extraToggle =
            'on';

        Object.assign(
            onButton.style,
            buttonStyle()
        );

        onButton.onclick =
            enableExtraNames;

        extraButtons.appendChild(
            onButton
        );

        const offButton =
            document.createElement(
                'button'
            );

        offButton.textContent =
            'KI';

        offButton.dataset.extraToggle =
            'off';

        Object.assign(
            offButton.style,
            buttonStyle()
        );

        offButton.onclick =
            disableExtraNames;

        extraButtons.appendChild(
            offButton
        );

        const refreshButton =
            document.createElement(
                'button'
            );

        refreshButton.textContent =
            'Frissítés';

        refreshButton.id =
            'otm-extra-refresh';

        Object.assign(
            refreshButton.style,
            buttonStyle()
        );

        refreshButton.onclick =
            manualRefresh;

        extraButtons.appendChild(
            refreshButton
        );

        body.appendChild(
            extraButtons
        );

        const hint =
            document.createElement(
                'div'
            );

        hint.textContent =
            'csúcsok + nyergek · zoom 12-től';

        Object.assign(
            hint.style,
            {
                marginTop:
                    '4px',

                fontSize:
                    '11px',

                color:
                    '#666'
            }
        );

        body.appendChild(hint);

        // --------------------------------------------------------
        // ÁLLAPOT
        // --------------------------------------------------------

        const status =
            document.createElement(
                'div'
            );

        status.id =
            'otm-status';

        Object.assign(
            status.style,
            {
                marginTop:
                    '8px',

                paddingTop:
                    '6px',

                borderTop:
                    '1px solid #ddd',

                fontSize:
                    '11px',

                color:
                    '#555',

                lineHeight:
                    '1.4'
            }
        );

        body.appendChild(status);

        document.body.appendChild(
            panel
        );

        updateControls();
        updateStatus();
    }

    function sectionTitle(text) {
        const title =
            document.createElement(
                'div'
            );

        title.textContent =
            text;

        Object.assign(
            title.style,
            {
                fontWeight:
                    'bold',

                marginTop:
                    '10px',

                marginBottom:
                    '5px'
            }
        );

        return title;
    }

    function smallLabel(text) {
        const label =
            document.createElement(
                'div'
            );

        label.textContent =
            text;

        Object.assign(
            label.style,
            {
                fontSize:
                    '12px',

                marginBottom:
                    '4px',

                color:
                    '#444'
            }
        );

        return label;
    }

    function buttonStyle() {
        return {
            marginRight:
                '4px',

            marginBottom:
                '3px',

            padding:
                '4px 7px',

            border:
                '1px solid #888',

            borderRadius:
                '5px',

            background:
                '#f7f7f7',

            cursor:
                'pointer'
        };
    }

    // ============================================================
    // KEZELŐSZERVEK FRISSÍTÉSE
    // ============================================================

    function updateControls() {
        const slider =
            document.getElementById(
                'otm-label-slider'
            );

        const labelValue =
            document.getElementById(
                'otm-label-value'
            );

        if (slider) {
            slider.value =
                String(
                    Math.round(
                        labelScale * 100
                    )
                );
        }

        if (labelValue) {
            labelValue.textContent =
                `${Math.round(
                    labelScale * 100
                )}%`;
        }

        document
            .querySelectorAll(
                '#otm-control-panel button[data-contour-scale]'
            )
            .forEach(
                button => {
                    const active =
                        Number(
                            button.dataset.contourScale
                        )
                        === contourScale;

                    styleActiveButton(
                        button,
                        active
                    );
                }
            );

        document
            .querySelectorAll(
                '#otm-control-panel button[data-extra-toggle]'
            )
            .forEach(
                button => {
                    let active = false;

                    if (
                        button.dataset.extraToggle
                        === 'on'
                    ) {
                        active =
                            extraNamesOn;

                    } else if (
                        button.dataset.extraToggle
                        === 'off'
                    ) {
                        active =
                            !extraNamesOn;
                    }

                    styleActiveButton(
                        button,
                        active
                    );
                }
            );

        const colorSelect =
            document.getElementById(
                'otm-contour-color'
            );

        if (colorSelect) {
            colorSelect.value =
                contourColor;
        }

        const refreshButton =
            document.getElementById(
                'otm-extra-refresh'
            );

        if (refreshButton) {
            refreshButton.disabled =
                !extraNamesOn;

            refreshButton.style.opacity =
                extraNamesOn
                    ? '1'
                    : '0.45';

            refreshButton.style.cursor =
                extraNamesOn
                    ? 'pointer'
                    : 'default';
        }
    }

    function styleActiveButton(
        button,
        active
    ) {
        button.style.fontWeight =
            active
                ? 'bold'
                : 'normal';

        button.style.outline =
            active
                ? '2px solid #000'
                : 'none';

        button.style.background =
            active
                ? '#e5e5e5'
                : '#f7f7f7';
    }

    function updateStatus() {
        const status =
            document.getElementById(
                'otm-status'
            );

        if (!status) return;

        if (!capturedMap) {
            status.textContent =
                'Térkép: még nincs elkapva';

            return;
        }

        status.innerHTML =
            `Térkép: OK · feliratrétegek: ${originalTextSizes.size}<br>` +
            extraStatusText;
    }

    // ============================================================
    // INDÍTÁS
    // ============================================================

    if (
        document.readyState
        === 'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            makePanel
        );

    } else {
        makePanel();
    }

})();
