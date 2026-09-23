// ==UserScript==
// @name         OpenTopoMap Vector – saját beállítások
// @namespace    local.opentopomap
// @version      2.1
// @description  Feliratméret, szintvonal-vastagság és opcionális OSM csúcs/nyereg nevek
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

    const LABEL_KEY   = 'otm-label-scale';
    const CONTOUR_KEY = 'otm-contour-scale';

    const CACHE_DATA_KEY   = 'otm-extra-cache-data-v2';
    const CACHE_BOUNDS_KEY = 'otm-extra-cache-bounds-v2';
    const CACHE_TIME_KEY   = 'otm-extra-cache-time-v2';

    const SCALE_VALUES = [1, 1.25, 1.5, 1.75, 2];
    const EXTRA_MIN_ZOOM = 12;
    const CACHE_MAX_AGE = 6 * 60 * 60 * 1000;

    let labelScale =
        Number(localStorage.getItem(LABEL_KEY) || 1.5);

    let contourScale =
        Number(localStorage.getItem(CONTOUR_KEY) || 1.5);

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
                            rememberOriginalContourWidth();

                            applyLabelScale();
                            applyContourScale();

                            extraNamesOn = false;
                            extraStatusText = 'OSM-nevek: KI';

                            updateButtons();
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
        updateButtons();
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
    // SZINTVONAL-VASTAGSÁG
    // ============================================================

    function rememberOriginalContourWidth() {
        if (
            !capturedMap ||
            originalContourWidth !== null
        ) {
            return;
        }

        try {
            const width =
                capturedMap.getPaintProperty(
                    'contour-lines',
                    'line-width'
                );

            if (width != null) {
                originalContourWidth =
                    structuredClone(width);
            }

        } catch (e) {
            console.warn(
                'Szintvonal:',
                e
            );
        }
    }

    function applyContourScale() {
        if (!capturedMap) return;

        rememberOriginalContourWidth();

        if (originalContourWidth == null) {
            return;
        }

        try {
            capturedMap.setPaintProperty(
                'contour-lines',
                'line-width',
                scaleExpression(
                    originalContourWidth,
                    contourScale
                )
            );

        } catch (e) {
            console.warn(
                'Szintvonal:',
                e
            );
        }

        updateButtons();
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
            updateButtons();
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

            updateButtons();
            updateStatus();
            return;
        }

        const cacheLoaded =
            loadCachedNamesForCurrentView();

        if (!cacheLoaded) {
            extraStatusText =
                'OSM-nevek: BE · lekérdezés indul…';
        }

        updateButtons();
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

        updateButtons();
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
                position:
                    'fixed',

                top:
                    '12px',

                right:
                    '12px',

                zIndex:
                    '999999',

                background:
                    'rgba(255,255,255,.96)',

                border:
                    '1px solid #888',

                borderRadius:
                    '8px',

                padding:
                    '9px',

                boxShadow:
                    '0 2px 8px rgba(0,0,0,.25)',

                font:
                    '13px Arial,sans-serif',

                color:
                    '#000'
            }
        );

        addScaleSection(
            panel,
            'Feliratméret',
            'label'
        );

        addScaleSection(
            panel,
            'Szintvonal',
            'contour'
        );

        // --------------------------------------------------------
        // DOMBORZATI NEVEK
        // --------------------------------------------------------

        const title =
            document.createElement(
                'div'
            );

        title.textContent =
            'Domborzati nevek';

        title.style.fontWeight =
            'bold';

        title.style.marginTop =
            '10px';

        title.style.marginBottom =
            '5px';

        panel.appendChild(title);

        const extraButtons =
            document.createElement(
                'div'
            );

        // BE

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

        // KI

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

        // FRISSÍTÉS

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

        panel.appendChild(
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

        panel.appendChild(hint);

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

        panel.appendChild(status);
        document.body.appendChild(panel);

        updateButtons();
        updateStatus();
    }

    function addScaleSection(
        panel,
        titleText,
        type
    ) {
        const title =
            document.createElement(
                'div'
            );

        title.textContent =
            titleText;

        title.style.fontWeight =
            'bold';

        title.style.marginTop =
            type === 'contour'
                ? '10px'
                : '0';

        title.style.marginBottom =
            '5px';

        panel.appendChild(title);

        const container =
            document.createElement(
                'div'
            );

        for (
            const value
            of SCALE_VALUES
        ) {
            const button =
                document.createElement(
                    'button'
                );

            button.textContent =
                `${Math.round(
                    value * 100
                )}%`;

            button.dataset.type =
                type;

            button.dataset.scale =
                String(value);

            Object.assign(
                button.style,
                buttonStyle()
            );

            button.onclick =
                () => {

                    if (
                        type === 'label'
                    ) {
                        labelScale =
                            value;

                        localStorage.setItem(
                            LABEL_KEY,
                            String(value)
                        );

                        applyLabelScale();

                    } else {
                        contourScale =
                            value;

                        localStorage.setItem(
                            CONTOUR_KEY,
                            String(value)
                        );

                        applyContourScale();
                    }
                };

            container.appendChild(
                button
            );
        }

        panel.appendChild(
            container
        );
    }

    function buttonStyle() {
        return {
            marginRight:
                '4px',

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

    function updateButtons() {
        document
            .querySelectorAll(
                '#otm-control-panel button'
            )
            .forEach(
                button => {

                    let active = false;

                    if (
                        button.dataset.type
                        === 'label'
                    ) {
                        active =
                            Number(
                                button.dataset.scale
                            )
                            === labelScale;

                    } else if (
                        button.dataset.type
                        === 'contour'
                    ) {
                        active =
                            Number(
                                button.dataset.scale
                            )
                            === contourScale;

                    } else if (
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
            );

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
