// Pure Canvas NASA Moon Trek WMTS Tile Loader
// NO LIBRARIES - Direct WMTS tile fetching and rendering

const API_URL = 'http://localhost:5001/api';
const WMTS_BASE = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm';
// DEM (elevation) tiles - Global Lunar DEM 100m/pixel
const DEM_BASE = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_GLD100/1.0.0/default/default028mm';

class MissionControl {
    constructor() {
        this.canvas = document.getElementById('mapCanvas');
        this.ctx = this.canvas.getContext('2d');

        // WMTS tile cache
        this.tiles = new Map(); // Key: "z/x/y" -> Image (imagery)
        this.loadingTiles = new Set();

        // DEM (elevation) tile cache
        this.demTiles = new Map(); // Key: "z/x/y" -> Image (elevation data)
        this.loadingDemTiles = new Set();

        // Viewport - Start at zoom 6 on mission area
        this.zoom = 6; // Good balance for visibility
        this.centerX = 0; // Longitude -180 to 180
        this.centerY = 0; // Latitude -90 to 90
        this.minZoom = 0;
        this.maxZoom = 8;

        // Dragging
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;

        // Mission
        this.path = [];
        this.pathIndex = 0;
        this.isRunning = false;
        this.isPaused = false;

        // Base and rover start at (0,0)
        this.basePos = { x: 0, z: 0 };
        this.roverPos = { x: 0, z: 0 };
        this.targetPos = { x: 0, z: 0 };
        this.initialRoverPos = { x: 0, z: 0 };
        this.heading = 0;
        this.speed = 0;

        // Exploration cycle state machine
        this.missionPhase = 'IDLE'; // IDLE | TO_TARGET | AT_TARGET | RETURNING | AT_BASE
        this.exploredPoints = [];
        this.missionCount = 0;
        this.currentExplorationId = null;
        this.currentOutboundPath = [];
        this.routeColors = ['#e06c75','#61afef','#98c379','#e5c07b','#c678dd','#56b6c2','#d19a66','#be5046','#7ec8e3','#c3e88d','#f78c6c','#ff75b5'];
        this.lunarPrefixes = ['Crater','Mare','Mons','Vallis','Rima','Lacus','Sinus','Dorsum','Rupes','Promontorium'];
        this.lunarSuffixes = ['Alpha','Beta','Gamma','Delta','Tycho','Kepler','Copernicus','Aristarchus','Plato','Armstrong','Aldrin','Artemis','Selene','Luna','Tranquillitatis','Serenity','Imbrium'];
        this.usedNames = new Set();

        // Time multiplier for speed control
        this.timeMultiplier = 1; // 1x, 2x, 5x, 10x

        // Obstacle avoidance system
        this.pathObstacles = [];       // {pos, radius, mesh3D} - rocks spawned on route
        this.obstacleAlertActive = false;
        this.obstacleAvoidanceCount = 0;

        // 3D exploration markers
        this.baseMarker3D = null;
        this.exploredMarkers3D = [];
        this.savedRouteLines3D = [];

        // Center camera on base (0,0)
        const baseLL = this.worldToLonLat(0, 0);
        this.centerX = baseLL.lon;
        this.centerY = baseLL.lat;

        this.tasks = [
            { id: 1, name: 'Initialize Systems', done: true },
            { id: 2, name: 'Load NASA Moon Trek WMTS', done: true },
            { id: 3, name: 'Establish Base Station', done: false },
            { id: 4, name: 'Begin Exploration Cycle', done: false, active: true },
            { id: 5, name: 'Navigate to Target', done: false },
            { id: 6, name: 'Return to Base', done: false }
        ];

        this.logs = [];

        // Detected obstacles from image processing
        this.detectedObstacles = [];

        // Front camera 3D view with Three.js
        this.frontCameraCanvas = document.getElementById('frontCamera');
        this.setup3DCamera();

        this.init();
    }

    async init() {
        console.log('🌙 NASA Moon Trek WMTS Mission Control');

        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());

        this.updateTimestamp();
        setInterval(() => this.updateTimestamp(), 1000);

        this.renderTasks();
        this.addLog('System initialized', true);
        this.addLog('🛰️ NASA Moon Trek WMTS loading...', true);

        this.setupMouseControls();
        this.setupUI();
        this.setupKeyboardShortcuts();
        this.setupCameraPanelDrag();
        this.setupCameraPanelResize();

        // Update target input fields
        document.getElementById('targetX').value = '0.0';
        document.getElementById('targetZ').value = '0.0';

        await fetch(`${API_URL}/obstacles/generate`);

        // Start render loop
        this.renderLoop();

        // Front camera 3D view setup
        this.resizeFrontCamera();
        window.addEventListener('resize', () => this.resizeFrontCamera());
        setInterval(() => this.renderFrontCamera(), 50);

        // Update loop
        setInterval(() => {
            if (this.isRunning && !this.isPaused) {
                this.updateRover();
            }
        }, 50);

        this.addLog('✅ NASA Moon Trek WMTS ready!', true);
        this.addLog('Awaiting mission start');

        document.getElementById('loading').style.display = 'none';
        console.log('✅ Ready');
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key.toLowerCase()) {
                case ' ':
                    e.preventDefault();
                    if (!this.isRunning) {
                        this.start();
                    } else {
                        this.pause();
                    }
                    break;
                case 'escape': {
                    const cam = document.getElementById('camPanel');
                    if (cam && cam.classList.contains('fullscreen')) this.toggleCameraFullscreen();
                    break;
                }
                case 'f':
                    this.toggleCameraFullscreen();
                    e.preventDefault();
                    break;
            }
        });
    }

    toggleCameraFullscreen() {
        const panel = document.getElementById('camPanel');
        if (!panel) return;
        panel.classList.remove('minimized');
        panel.classList.toggle('fullscreen');
        const btn = document.getElementById('camFullBtn');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) icon.className = panel.classList.contains('fullscreen') ? 'fas fa-compress' : 'fas fa-expand';
        }
        const minBtn = document.getElementById('camMinBtn');
        if (minBtn) {
            const icon = minBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-minus';
        }
        setTimeout(() => this.resizeFrontCamera(), 60);
    }

    setupCameraPanelDrag() {
        const panel = document.getElementById('camPanel');
        const handle = document.getElementById('camPanelDrag');
        if (!panel || !handle) return;

        let dragging = false;
        let startMouseX = 0;
        let startMouseY = 0;
        let startPanelX = 0;
        let startPanelY = 0;

        handle.addEventListener('mousedown', (e) => {
            if (panel.classList.contains('fullscreen')) return;
            dragging = true;
            startMouseX = e.clientX;
            startMouseY = e.clientY;

            const rect = panel.getBoundingClientRect();
            const parentRect = panel.parentElement.getBoundingClientRect();
            startPanelX = rect.left - parentRect.left;
            startPanelY = rect.top - parentRect.top;

            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const parentRect = panel.parentElement.getBoundingClientRect();

            let x = startPanelX + (e.clientX - startMouseX);
            let y = startPanelY + (e.clientY - startMouseY);

            x = Math.max(0, Math.min(parentRect.width - panel.offsetWidth, x));
            y = Math.max(0, Math.min(parentRect.height - panel.offsetHeight, y));

            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                document.body.style.userSelect = '';
            }
        });

        // Minimize button
        const minBtn = document.getElementById('camMinBtn');
        if (minBtn) {
            minBtn.addEventListener('click', () => {
                if (panel.classList.contains('fullscreen')) return;
                const isMin = panel.classList.toggle('minimized');
                minBtn.querySelector('i').className = isMin ? 'fas fa-plus' : 'fas fa-minus';
                if (!isMin) setTimeout(() => this.resizeFrontCamera(), 60);
            });
        }

        // Fullscreen button
        const fullBtn = document.getElementById('camFullBtn');
        if (fullBtn) {
            fullBtn.addEventListener('click', () => this.toggleCameraFullscreen());
        }
    }

    setupCameraPanelResize() {
        const panel = document.getElementById('camPanel');
        const handle = document.getElementById('camResizeHandle');
        if (!panel || !handle) return;

        let resizing = false;
        let startW = 0;
        let startH = 0;
        let startMouseX = 0;
        let startMouseY = 0;

        handle.addEventListener('mousedown', (e) => {
            if (panel.classList.contains('fullscreen') || panel.classList.contains('minimized')) return;
            resizing = true;
            startW = panel.offsetWidth;
            startH = panel.offsetHeight;
            startMouseX = e.clientX;
            startMouseY = e.clientY;
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            let newW = startW + (e.clientX - startMouseX);
            let newH = startH + (e.clientY - startMouseY);
            newW = Math.max(200, Math.min(800, newW));
            newH = Math.max(140, Math.min(600, newH));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            this.resizeFrontCamera();
        });

        document.addEventListener('mouseup', () => {
            if (resizing) {
                resizing = false;
                document.body.style.userSelect = '';
                this.resizeFrontCamera();
            }
        });

        // Also observe with ResizeObserver for any other size changes
        if (typeof ResizeObserver !== 'undefined') {
            this._camResizeObserver = new ResizeObserver(() => {
                this.resizeFrontCamera();
            });
            this._camResizeObserver.observe(panel);
        }
    }

    resizeCanvas() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
    }

    setupMouseControls() {
        // Mouse wheel zoom
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            const oldZoom = this.zoom;
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * zoomFactor));

            // Zoom toward mouse
            if (this.zoom !== oldZoom) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const factor = 1 - this.zoom / oldZoom;
                const dx = (mouseX - this.canvas.width / 2) / this.getScale();
                const dy = (mouseY - this.canvas.height / 2) / this.getScale();

                this.centerX += dx * factor;
                this.centerY += dy * factor;
            }

            this.addLog(`Zoom: ${this.zoom.toFixed(1)}x`);
        });

        // Mouse drag + click detection
        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.clickStartX = e.clientX;
            this.clickStartY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                const dx = e.clientX - this.dragStartX;
                const dy = e.clientY - this.dragStartY;

                const tilesAtZoom = Math.pow(2, Math.floor(this.zoom) + 1);
                const tileSize = 256;
                const pixelsPerDegree = tileSize * tilesAtZoom / 360;

                // Fix drag direction - drag up should move map up
                this.centerX -= dx / pixelsPerDegree;
                this.centerY += dy / pixelsPerDegree; // Inverted Y

                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            const moveX = Math.abs(e.clientX - this.clickStartX);
            const moveY = Math.abs(e.clientY - this.clickStartY);
            const wasClick = moveX < 5 && moveY < 5;

            this.isDragging = false;
            this.canvas.style.cursor = 'grab';

            if (wasClick) {
                this.handleMapClick(e);
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.isDragging = false;
            this.canvas.style.cursor = 'grab';
        });

        this.canvas.style.cursor = 'grab';
    }

    screenToLonLat(screenX, screenY) {
        const z = Math.floor(this.zoom);
        const tileSize = 256;
        const tilesAtZoom = Math.pow(2, z + 1);

        const centerTileX = (this.centerX + 180) / 360 * tilesAtZoom;
        const centerTileY = (90 - this.centerY) / 180 * (tilesAtZoom / 2);

        const deltaTileX = (screenX - this.canvas.width / 2) / tileSize;
        const deltaTileY = (screenY - this.canvas.height / 2) / tileSize;

        const tileX = centerTileX + deltaTileX;
        const tileY = centerTileY + deltaTileY;

        const lon = (tileX / tilesAtZoom) * 360 - 180;
        const lat = 90 - (tileY / (tilesAtZoom / 2)) * 180;

        return { lon, lat };
    }

    handleMapClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        const { lon, lat } = this.screenToLonLat(screenX, screenY);
        const world = this.lonLatToWorld(lon, lat);

        this.targetPos = { x: world.x, z: world.z };

        // Update input fields
        document.getElementById('targetX').value = world.x.toFixed(1);
        document.getElementById('targetZ').value = world.z.toFixed(1);

        this.addLog(`Target set to (${world.x.toFixed(1)}, ${world.z.toFixed(1)})`, true);

        // Update task list
        const targetTask = this.tasks.find(t => t.id === 5);
        if (targetTask) {
            targetTask.name = `Navigate to Target (${world.x.toFixed(0)}, ${world.z.toFixed(0)})`;
            this.renderTasks();
        }

        // If mission is running, recalculate path
        if (this.isRunning && !this.isPaused) {
            this.addLog('Recalculating route to new target...');
            this.fetchPath();
        }
    }

    getScale() {
        // Pixels per degree
        const worldWidth = 360; // degrees
        const tileSize = 256;
        const tilesAtZoom = Math.pow(2, Math.floor(this.zoom) + 1);
        return (tilesAtZoom * tileSize) / worldWidth;
    }

    lonLatToWorld(lon, lat) {
        // Convert lon/lat to our world coordinates (-100 to 100)
        const x = (lon / 180) * 100;
        const z = (lat / 90) * 100;
        return { x, z };
    }

    worldToLonLat(x, z) {
        // Convert our world coords to lon/lat
        const lon = (x / 100) * 180;
        const lat = (z / 100) * 90;
        return { lon, lat };
    }

    getTileCoords(lon, lat, zoom) {
        // Convert lon/lat to tile coordinates
        const z = Math.floor(zoom);
        const n = Math.pow(2, z + 1);

        const x = Math.floor((lon + 180) / 360 * n);
        const y = Math.floor((90 - lat) / 180 * n);

        return { x, y, z };
    }

    getTerrainBrightness(lon, lat) {
        // Quick brightness lookup for 3D rendering
        const z = Math.floor(this.zoom);
        const tilesAtZoom = Math.pow(2, z + 1);

        const tileX = Math.floor((lon + 180) / 360 * tilesAtZoom);
        const tileY = Math.floor((90 - lat) / 180 * (tilesAtZoom / 2));

        const wrappedX = ((tileX % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;
        const key = `${z}/${wrappedX}/${tileY}`;

        const imageryTile = this.tiles.get(key);
        if (!imageryTile) {
            return 128; // Default mid-gray
        }

        // Get pixel position within tile
        const tileSize = 256;
        const pixelX = ((lon + 180) / 360 * tilesAtZoom - tileX) * tileSize;
        const pixelY = ((90 - lat) / 180 * (tilesAtZoom / 2) - tileY) * tileSize;

        // Sample brightness - use cached canvas if available
        if (!this._brightnessCache) {
            this._brightnessCache = {};
        }

        if (!this._brightnessCache[key]) {
            const canvas = document.createElement('canvas');
            canvas.width = tileSize;
            canvas.height = tileSize;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imageryTile, 0, 0);
            this._brightnessCache[key] = ctx.getImageData(0, 0, tileSize, tileSize);
        }

        const imageData = this._brightnessCache[key];
        const idx = (Math.floor(pixelY) * tileSize + Math.floor(pixelX)) * 4;
        return imageData.data[idx] || 128;
    }

    getElevationAt(lon, lat) {
        // Get elevation from imagery tile brightness (bright = high, dark = low)
        const z = Math.floor(this.zoom);
        const tilesAtZoom = Math.pow(2, z + 1);

        const tileX = Math.floor((lon + 180) / 360 * tilesAtZoom);
        const tileY = Math.floor((90 - lat) / 180 * (tilesAtZoom / 2));

        const wrappedX = ((tileX % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;
        const key = `${z}/${wrappedX}/${tileY}`;

        const imageryTile = this.tiles.get(key);
        if (!imageryTile) {
            return null; // Imagery tile not loaded yet
        }

        // Get pixel position within tile
        const tileSize = 256;
        const pixelX = ((lon + 180) / 360 * tilesAtZoom - tileX) * tileSize;
        const pixelY = ((90 - lat) / 180 * (tilesAtZoom / 2) - tileY) * tileSize;

        // Sample brightness from imagery tile
        const canvas = document.createElement('canvas');
        canvas.width = tileSize;
        canvas.height = tileSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageryTile, 0, 0);

        try {
            const imageData = ctx.getImageData(Math.floor(pixelX), Math.floor(pixelY), 1, 1);
            const data = imageData.data;

            // Use brightness as elevation proxy
            // Bright areas (highlands) = high elevation
            // Dark areas (maria/craters) = low elevation
            const brightness = data[0]; // R channel (grayscale)

            // Map brightness to elevation range
            // 0 (dark) = -2000m, 255 (bright) = +2000m
            const elevation = -2000 + (brightness / 255) * 4000;

            return elevation;
        } catch (e) {
            return null;
        }
    }

    loadTile(x, y, z) {
        const key = `${z}/${x}/${y}`;

        // Already loaded or loading
        if (this.tiles.has(key) || this.loadingTiles.has(key)) {
            return this.tiles.get(key);
        }

        this.loadingTiles.add(key);

        const url = `${WMTS_BASE}/${z}/${y}/${x}.jpg`;
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            this.tiles.set(key, img);
            this.loadingTiles.delete(key);
        };

        img.onerror = () => {
            this.loadingTiles.delete(key);
            console.warn(`❌ Tile failed: ${key}`);
        };

        img.src = url;
        return null;
    }


    renderLoop() {
        this.render();
        requestAnimationFrame(() => this.renderLoop());
    }

    render() {
        const ctx = this.ctx;

        // Clear
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();

        // Calculate tile positioning
        const z = Math.floor(this.zoom);
        const tileSize = 256;
        const tilesAtZoom = Math.pow(2, z + 1);

        // Convert center lon/lat to tile coordinates
        const centerTileX = (this.centerX + 180) / 360 * tilesAtZoom;
        const centerTileY = (90 - this.centerY) / 180 * (tilesAtZoom / 2);

        // Calculate offset within tile
        const offsetX = (centerTileX - Math.floor(centerTileX)) * tileSize;
        const offsetY = (centerTileY - Math.floor(centerTileY)) * tileSize;

        // Top-left tile on screen
        const startTileX = Math.floor(centerTileX) - Math.ceil(this.canvas.width / tileSize / 2) - 1;
        const startTileY = Math.floor(centerTileY) - Math.ceil(this.canvas.height / tileSize / 2) - 1;

        // Number of tiles to draw
        const numTilesX = Math.ceil(this.canvas.width / tileSize) + 2;
        const numTilesY = Math.ceil(this.canvas.height / tileSize) + 2;

        // Screen position for first tile
        const startScreenX = this.canvas.width / 2 - offsetX - (Math.floor(centerTileX) - startTileX) * tileSize;
        const startScreenY = this.canvas.height / 2 - offsetY - (Math.floor(centerTileY) - startTileY) * tileSize;

        // Draw tiles
        for (let i = 0; i < numTilesX; i++) {
            for (let j = 0; j < numTilesY; j++) {
                const tileX = startTileX + i;
                const tileY = startTileY + j;

                // Wrap X, clamp Y
                const wrappedTileX = ((tileX % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;

                if (tileY >= 0 && tileY < tilesAtZoom / 2) {
                    const tile = this.loadTile(wrappedTileX, tileY, z);

                    if (tile) {
                        const x = startScreenX + i * tileSize;
                        const y = startScreenY + j * tileSize;
                        ctx.drawImage(tile, x, y, tileSize, tileSize);
                    }
                }
            }
        }

        // Draw mission elements
        this.drawMissionElements(ctx, z, tilesAtZoom, tileSize);

        ctx.restore();

        // UI overlays
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '12px monospace';
        ctx.fillText(`Zoom: ${this.zoom.toFixed(1)}x | Tiles: ${this.tiles.size}`, 10, this.canvas.height - 10);
    }

    drawMissionElements(ctx, z, tilesAtZoom, tileSize) {
        // Convert rover world coords to lon/lat
        const roverLL = this.worldToLonLat(this.roverPos.x, this.roverPos.z);
        const targetLL = this.worldToLonLat(this.targetPos.x, this.targetPos.z);

        // Helper function to convert lon/lat to screen position
        const lonLatToScreen = (lon, lat) => {
            const tileX = (lon + 180) / 360 * tilesAtZoom;
            const tileY = (90 - lat) / 180 * (tilesAtZoom / 2);

            const centerTileX = (this.centerX + 180) / 360 * tilesAtZoom;
            const centerTileY = (90 - this.centerY) / 180 * (tilesAtZoom / 2);

            const deltaX = (tileX - centerTileX) * tileSize;
            const deltaY = (tileY - centerTileY) * tileSize;

            return {
                x: this.canvas.width / 2 + deltaX,
                y: this.canvas.height / 2 + deltaY
            };
        };

        const roverScreen = lonLatToScreen(roverLL.lon, roverLL.lat);
        const targetScreen = lonLatToScreen(targetLL.lon, targetLL.lat);

        const roverX = roverScreen.x;
        const roverY = roverScreen.y;
        const targetX = targetScreen.x;
        const targetY = targetScreen.y;

        // Scale for distance conversion (approximate)
        const pixelsPerDegree = tileSize * tilesAtZoom / 360;
        const rangeRadius = 80 * pixelsPerDegree / 100;
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(roverX, roverY, rangeRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // --- Draw saved routes (under active path) ---
        for (const point of this.exploredPoints) {
            // Outbound path (solid, alpha 0.5)
            if (point.outboundPath && point.outboundPath.length > 1) {
                ctx.strokeStyle = point.color;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = 0.5;
                ctx.beginPath();
                for (let i = 0; i < point.outboundPath.length; i++) {
                    const pLL = this.worldToLonLat(point.outboundPath[i].x, point.outboundPath[i].z);
                    const pScreen = lonLatToScreen(pLL.lon, pLL.lat);
                    if (i === 0) ctx.moveTo(pScreen.x, pScreen.y);
                    else ctx.lineTo(pScreen.x, pScreen.y);
                }
                ctx.stroke();
            }
            // Return path (dashed, alpha 0.5)
            if (point.returnPath && point.returnPath.length > 1) {
                ctx.strokeStyle = point.color;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = 0.4;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                for (let i = 0; i < point.returnPath.length; i++) {
                    const pLL = this.worldToLonLat(point.returnPath[i].x, point.returnPath[i].z);
                    const pScreen = lonLatToScreen(pLL.lon, pLL.lat);
                    if (i === 0) ctx.moveTo(pScreen.x, pScreen.y);
                    else ctx.lineTo(pScreen.x, pScreen.y);
                }
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.globalAlpha = 1.0;
        }

        // --- Draw BASE marker ---
        const baseLL = this.worldToLonLat(this.basePos.x, this.basePos.z);
        const baseScreen = lonLatToScreen(baseLL.lon, baseLL.lat);
        // Cyan ring
        ctx.strokeStyle = '#00cccc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(baseScreen.x, baseScreen.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        // Filled inner circle
        ctx.fillStyle = 'rgba(0, 204, 204, 0.4)';
        ctx.beginPath();
        ctx.arc(baseScreen.x, baseScreen.y, 6, 0, Math.PI * 2);
        ctx.fill();
        // "BASE" label
        ctx.fillStyle = '#00cccc';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('BASE', baseScreen.x, baseScreen.y - 14);

        // --- Draw explored points ---
        for (const point of this.exploredPoints) {
            const pLL = this.worldToLonLat(point.pos.x, point.pos.z);
            const pScreen = lonLatToScreen(pLL.lon, pLL.lat);
            // White border circle
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(pScreen.x, pScreen.y, 6, 0, Math.PI * 2);
            ctx.stroke();
            // Colored fill
            ctx.fillStyle = point.color;
            ctx.beginPath();
            ctx.arc(pScreen.x, pScreen.y, 4, 0, Math.PI * 2);
            ctx.fill();
            // Name label
            ctx.fillStyle = '#ffffff';
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(point.name, pScreen.x, pScreen.y - 9);
        }

        ctx.textAlign = 'left'; // Reset

        // --- Draw path obstacles (rocks) ---
        for (const obs of this.pathObstacles) {
            const oLL = this.worldToLonLat(obs.pos.x, obs.pos.z);
            const oScreen = lonLatToScreen(oLL.lon, oLL.lat);
            const r = Math.max(3, obs.radius * pixelsPerDegree / 100 * 1.8);

            if (obs.detected) {
                // Detected - red X
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(oScreen.x - r, oScreen.y - r);
                ctx.lineTo(oScreen.x + r, oScreen.y + r);
                ctx.moveTo(oScreen.x + r, oScreen.y - r);
                ctx.lineTo(oScreen.x - r, oScreen.y + r);
                ctx.stroke();
            } else {
                // Undetected - dim brown dot (hidden danger)
                ctx.fillStyle = 'rgba(120, 80, 40, 0.4)';
                ctx.beginPath();
                ctx.arc(oScreen.x, oScreen.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Draw active path (thinner)
        if (this.path.length > 0) {
            ctx.strokeStyle = '#c678dd';
            ctx.lineWidth = 2;
            ctx.shadowColor = '#c678dd';
            ctx.shadowBlur = 4;
            ctx.beginPath();

            for (let i = 0; i < this.path.length; i++) {
                const pLL = this.worldToLonLat(this.path[i].x, this.path[i].z);
                const pScreen = lonLatToScreen(pLL.lon, pLL.lat);

                if (i === 0) ctx.moveTo(pScreen.x, pScreen.y);
                else ctx.lineTo(pScreen.x, pScreen.y);
            }

            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        // Don't draw obstacle markers on map anymore - only use terrain-based pathfinding

        // Draw target (scaled for zoom 6)
        ctx.fillStyle = '#f0c040';
        ctx.shadowColor = '#f0c040';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(targetX, targetY, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Draw rover (scaled to zoom level)
        ctx.save();
        ctx.translate(roverX, roverY);
        ctx.rotate(this.heading);

        // Size based on zoom level - bigger at zoom 6
        const roverSize = 6; // Pixels (bigger for zoom 6)

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 0.5;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 8;

        ctx.beginPath();
        ctx.moveTo(0, -roverSize);
        ctx.lineTo(-roverSize * 0.7, roverSize);
        ctx.lineTo(roverSize * 0.7, roverSize);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.restore();
    }

    setup3DCamera() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x020208);
        this.scene.fog = new THREE.FogExp2(0x020208, 0.008);

        // Camera - third-person perspective
        const parent = this.frontCameraCanvas.parentElement;
        const aspect = parent.clientWidth / parent.clientHeight;
        this.camera = new THREE.PerspectiveCamera(65, aspect, 0.1, 1000);
        this.camera.position.set(0, 15, -20);

        // Smooth camera interpolation targets
        this.targetCamPos = new THREE.Vector3(0, 15, -20);
        this.targetLookAt = new THREE.Vector3(0, 0, 0);
        this.currentLookAt = new THREE.Vector3(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.frontCameraCanvas,
            antialias: true
        });
        this.renderer.setSize(parent.clientWidth, parent.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Lunar lighting - harsh sun, minimal ambient (no atmosphere)
        const ambientLight = new THREE.AmbientLight(0x202025, 0.4);
        this.scene.add(ambientLight);

        const sunLight = new THREE.DirectionalLight(0xfff8e8, 2.0);
        sunLight.position.set(80, 120, 60);
        this.scene.add(sunLight);

        // Very faint fill to prevent total black shadows
        const fillLight = new THREE.DirectionalLight(0x404050, 0.15);
        fillLight.position.set(-40, 30, -50);
        this.scene.add(fillLight);

        this.createStarField();

        this.terrainMesh = null;
        this.roverRig = null;
        this.pathLine3D = null;
        this.targetMarker3D = null;
        this.is3DReady = false;

        console.log('✅ Three.js 3D camera (third-person) initialized');
    }

    createStarField() {
        const starGeometry = new THREE.BufferGeometry();
        const starCount = 1500;
        const positions = new Float32Array(starCount * 3);

        for (let i = 0; i < starCount * 3; i++) {
            positions[i] = (Math.random() - 0.5) * 300; // Wide distribution
        }

        starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const starMaterial = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.5,
            transparent: true,
            opacity: 0.8
        });

        const stars = new THREE.Points(starGeometry, starMaterial);
        this.scene.add(stars);
    }

    ensureRoverRig() {
        if (this.roverRig) return this.roverRig;

        this.roverRig = new THREE.Group();
        this.roverRig.rotation.order = 'YXZ';

        // Materials - realistic lunar rover
        const chassisMat = new THREE.MeshStandardMaterial({
            color: 0xd0cfc8, metalness: 0.3, roughness: 0.7 // Dusty white aluminum
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x2a2a2a, metalness: 0.4, roughness: 0.6 // Dark components
        });
        const goldFoilMat = new THREE.MeshStandardMaterial({
            color: 0xc8a832, metalness: 0.7, roughness: 0.25, // MLI gold foil
        });
        const solarMat = new THREE.MeshStandardMaterial({
            color: 0x1a2844, metalness: 0.5, roughness: 0.3 // Dark blue solar cells
        });
        const wheelMat = new THREE.MeshStandardMaterial({
            color: 0x555555, metalness: 0.5, roughness: 0.4 // Aluminum wheels
        });
        const redMat = new THREE.MeshStandardMaterial({
            color: 0xcc2222, emissive: 0x441111, emissiveIntensity: 0.3
        });

        // === CHASSIS (warm box body with thermal blanket look) ===
        const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 2.2), goldFoilMat);
        chassis.position.y = 0.58;
        this.roverRig.add(chassis);

        // Top instrument deck (white)
        const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 2.0), chassisMat);
        deck.position.y = 0.84;
        this.roverRig.add(deck);

        // === ROCKER-BOGIE SUSPENSION with 6 wheels ===
        const wheelRadius = 0.22;
        const wheelWidth = 0.12;
        const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 16);

        // Wheel tread pattern - outer ring
        const treadGeo = new THREE.TorusGeometry(wheelRadius, 0.03, 6, 16);

        const wheelConfigs = [
            { x: -0.95, z: -0.85, arm: -1 }, { x: 0.95, z: -0.85, arm: 1 }, // Front
            { x: -0.95, z: 0.0, arm: -1 },   { x: 0.95, z: 0.0, arm: 1 },   // Mid
            { x: -0.95, z: 0.75, arm: -1 },   { x: 0.95, z: 0.75, arm: 1 },   // Rear
        ];

        for (const wc of wheelConfigs) {
            // Wheel
            const wheel = new THREE.Mesh(wheelGeo, wheelMat);
            wheel.position.set(wc.x, 0.22, wc.z);
            wheel.rotation.z = Math.PI / 2;
            this.roverRig.add(wheel);

            // Tread ring
            const tread = new THREE.Mesh(treadGeo, darkMat);
            tread.position.set(wc.x, 0.22, wc.z);
            tread.rotation.y = Math.PI / 2;
            this.roverRig.add(tread);

            // Suspension arm connecting to chassis
            const armGeo = new THREE.BoxGeometry(0.06, 0.06, 0.35);
            const arm = new THREE.Mesh(armGeo, chassisMat);
            arm.position.set(wc.x * 0.6, 0.40, wc.z);
            this.roverRig.add(arm);
        }

        // === SOLAR PANEL (tilted, dark blue) ===
        const solarPanel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.03, 1.4), solarMat);
        solarPanel.position.set(0, 0.94, -0.1);
        solarPanel.rotation.x = -0.05; // Slight tilt toward sun
        this.roverRig.add(solarPanel);
        // Solar panel frame
        const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.82, 0.04, 1.42));
        const frameLine = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color: 0x888888 }));
        frameLine.position.copy(solarPanel.position);
        frameLine.rotation.copy(solarPanel.rotation);
        this.roverRig.add(frameLine);

        // === MAST CAMERA (tall, like Curiosity ChemCam) ===
        // Mast post
        const mastPost = new THREE.Mesh(
            new THREE.CylinderGeometry(0.035, 0.045, 1.0, 8), chassisMat
        );
        mastPost.position.set(0, 1.40, 0.75);
        this.roverRig.add(mastPost);

        // Camera head (box with lens)
        const camHead = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.18), darkMat);
        camHead.position.set(0, 1.96, 0.75);
        this.roverRig.add(camHead);

        // Two camera lenses (NavCam eyes)
        for (const side of [-0.07, 0.07]) {
            const lens = new THREE.Mesh(
                new THREE.CylinderGeometry(0.03, 0.035, 0.06, 12),
                darkMat
            );
            lens.position.set(side, 1.96, 0.88);
            lens.rotation.x = Math.PI / 2;
            this.roverRig.add(lens);
            // Lens glass
            const glass = new THREE.Mesh(
                new THREE.CircleGeometry(0.028, 12),
                new THREE.MeshStandardMaterial({ color: 0x334466, metalness: 0.8, roughness: 0.1 })
            );
            glass.position.set(side, 1.96, 0.91);
            this.roverRig.add(glass);
        }

        // === HIGH-GAIN ANTENNA (dish on back) ===
        const antennaMast = new THREE.Mesh(
            new THREE.CylinderGeometry(0.02, 0.025, 0.5, 6), chassisMat
        );
        antennaMast.position.set(-0.45, 1.15, -0.65);
        this.roverRig.add(antennaMast);

        const antennaDish = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            chassisMat
        );
        antennaDish.position.set(-0.45, 1.40, -0.65);
        antennaDish.rotation.x = Math.PI * 0.8;
        antennaDish.rotation.z = 0.3;
        this.roverRig.add(antennaDish);

        // === LOW-GAIN ANTENNA (thin whip) ===
        const whip = new THREE.Mesh(
            new THREE.CylinderGeometry(0.008, 0.012, 0.6, 4), chassisMat
        );
        whip.position.set(0.5, 1.20, -0.55);
        this.roverRig.add(whip);

        // === INSTRUMENT ARM (robotic arm, front-right) ===
        const armSeg1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.4), chassisMat);
        armSeg1.position.set(0.55, 0.65, 0.95);
        armSeg1.rotation.x = 0.3;
        this.roverRig.add(armSeg1);

        const armSeg2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.25), chassisMat);
        armSeg2.position.set(0.55, 0.55, 1.22);
        armSeg2.rotation.x = -0.4;
        this.roverRig.add(armSeg2);

        // === REAR RTG UNIT ===
        const rtg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.10, 0.5, 8), darkMat
        );
        rtg.position.set(0, 0.70, -1.15);
        rtg.rotation.x = Math.PI / 2;
        this.roverRig.add(rtg);

        // RTG fins
        for (let i = 0; i < 4; i++) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.02, 0.35), darkMat);
            fin.position.set(0, 0.70, -1.15);
            fin.rotation.z = (i / 4) * Math.PI;
            this.roverRig.add(fin);
        }

        // === RED HAZARD / TAILLIGHTS ===
        for (const side of [-0.6, 0.6]) {
            const tailLight = new THREE.Mesh(
                new THREE.BoxGeometry(0.06, 0.04, 0.04), redMat
            );
            tailLight.position.set(side, 0.50, -1.10);
            this.roverRig.add(tailLight);
        }

        // === HEADLIGHTS (white, front) ===
        for (const side of [-0.5, 0.5]) {
            const headlight = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8),
                new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffcc, emissiveIntensity: 0.8 })
            );
            headlight.position.set(side, 0.65, 1.12);
            headlight.rotation.x = Math.PI / 2;
            this.roverRig.add(headlight);
        }

        // Headlight illumination
        const headLightL = new THREE.SpotLight(0xffffee, 0.6, 8, Math.PI / 6, 0.5);
        headLightL.position.set(-0.5, 0.65, 1.12);
        headLightL.target.position.set(-0.5, 0, 5);
        this.roverRig.add(headLightL);
        this.roverRig.add(headLightL.target);

        const headLightR = new THREE.SpotLight(0xffffee, 0.6, 8, Math.PI / 6, 0.5);
        headLightR.position.set(0.5, 0.65, 1.12);
        headLightR.target.position.set(0.5, 0, 5);
        this.roverRig.add(headLightR);
        this.roverRig.add(headLightR.target);

        this.roverRig.scale.set(0.25, 0.25, 0.25);
        this.roverRig.visible = false;
        this.scene.add(this.roverRig);

        return this.roverRig;
    }

    build3DTerrain(elevationMap, mapSize = 100) {
        // Remove old terrain
        if (this.terrainMesh) {
            this.scene.remove(this.terrainMesh);
        }
        if (this.roverRig) {
            this.roverRig.visible = false;
        }

        // Higher resolution terrain geometry for detail
        const meshRes = mapSize - 1;
        const geometry = new THREE.PlaneGeometry(100, 100, meshRes, meshRes);
        const vertices = geometry.attributes.position.array;

        // Map elevation values to vertex Z coordinates
        let zmin = Infinity;
        let zmax = -Infinity;

        for (let y = 0; y < mapSize; y++) {
            for (let x = 0; x < mapSize; x++) {
                const i = (y * mapSize + x) * 3;
                const z_val = elevationMap[y][x];
                vertices[i + 2] = z_val;
                zmin = Math.min(zmin, z_val);
                zmax = Math.max(zmax, z_val);
            }
        }

        geometry.computeVertexNormals();

        // Lunar regolith vertex coloring - dusty/sandy moon surface
        const pos = geometry.attributes.position.array;
        const nor = geometry.attributes.normal.array;
        const zr = Math.max(zmax - zmin, 0.1);
        const colors = new Float32Array(pos.length);

        for (let vi = 0; vi < pos.length / 3; vi++) {
            const zi = pos[vi * 3 + 2];
            const nx = nor[vi * 3];
            const ny = nor[vi * 3 + 1];
            const nz = nor[vi * 3 + 2];

            const cz = (zi - zmin) / zr;
            const ridge = Math.sqrt(nx * nx + ny * ny);

            // Base shade: neutral gray lunar regolith
            let shade = 0.16 + 0.10 * nz + 0.04 * ridge + 0.05 * cz;

            // Deep crater floors - dark dusty
            if (cz < 0.10) shade *= 0.55;
            else if (cz < 0.20) shade *= 0.72;
            else if (cz < 0.30) shade *= 0.85;

            // Crater rims and ridges - sun-bleached bright
            if (ridge > 0.20) shade += 0.08 * ridge;
            if (ridge > 0.40) shade += 0.04;

            // Highlands slightly brighter dust
            if (cz > 0.70) shade += 0.04;

            // Multi-frequency noise for realistic dusty texture
            const px = pos[vi * 3];
            const py = pos[vi * 3 + 1];
            const h1 = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
            const h2 = Math.sin(px * 269.5 + py * 183.3) * 28461.3721;
            const h3 = Math.sin(px * 47.3 + py * 89.1) * 17853.9127;
            const n1 = ((h1 - Math.floor(h1)) - 0.5) * 0.04;
            const n2 = ((h2 - Math.floor(h2)) - 0.5) * 0.025;
            const n3 = ((h3 - Math.floor(h3)) - 0.5) * 0.015;
            shade += n1 + n2 + n3;

            shade = Math.min(0.48, Math.max(0.05, shade));

            // Neutral lunar gray - subtle cool tint like real moon regolith
            const variation = ((h1 - Math.floor(h1))) * 0.015; // subtle per-vertex color variation
            colors[vi * 3]     = shade * 1.02 + variation;  // R - near neutral
            colors[vi * 3 + 1] = shade * 1.01;               // G - near neutral
            colors[vi * 3 + 2] = shade * 0.98;               // B - very slight warm bias
        }

        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        // Lunar regolith material
        const material = new THREE.MeshStandardMaterial({
            vertexColors: THREE.VertexColors,
            roughness: 0.97,
            metalness: 0.0,
            flatShading: false,
        });

        this.terrainMesh = new THREE.Mesh(geometry, material);
        this.terrainMesh.rotation.x = -Math.PI / 2;
        this.scene.add(this.terrainMesh);

        this.elevationMapData = elevationMap;
        this.elevationMapSize = mapSize;
        this.is3DReady = true;

        console.log('3D terrain mesh built with', mapSize, 'x', mapSize, 'vertices');
    }

    // Bilinear interpolation for smooth elevation lookup
    elevBilinear(elev, fx, fy) {
        if (!elev || elev.length !== this.elevationMapSize) return 0;

        const w = this.elevationMapSize;
        const h = this.elevationMapSize;
        // Clamp to valid range
        fx = Math.max(0, Math.min(w - 1.001, fx));
        fy = Math.max(0, Math.min(h - 1.001, fy));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, w - 1);
        const y1 = Math.min(y0 + 1, h - 1);
        const tx = fx - x0;
        const ty = fy - y0;

        const z00 = elev[y0][x0];
        const z10 = elev[y0][x1];
        const z01 = elev[y1][x0];
        const z11 = elev[y1][x1];

        const a0 = z00 * (1 - tx) + z10 * tx;
        const a1 = z01 * (1 - tx) + z11 * tx;

        return a0 * (1 - ty) + a1 * ty;
    }

    // Calculate terrain slopes along forward and perpendicular directions
    terrainSlopesAlong(elev, fx, fy, fwdX, fwdY) {
        const e = 0.42;
        const dzdx = (this.elevBilinear(elev, fx + e, fy) - this.elevBilinear(elev, fx - e, fy)) / (2 * e);
        const dzdy = (this.elevBilinear(elev, fx, fy + e) - this.elevBilinear(elev, fx, fy - e)) / (2 * e);

        const len = Math.hypot(fwdX, fwdY) || 1;
        const ux = fwdX / len;
        const uy = fwdY / len;
        const px = -uy;
        const py = ux;

        const dz_fwd = dzdx * ux + dzdy * uy;
        const dz_perp = dzdx * px + dzdy * py;

        return { dz_fwd, dz_perp };
    }

    // Convert map coordinates to Three.js 3D coordinates
    getMap3DCoords(mx, my, mz) {
        // Map grid coords (0..mapSize-1) to mesh space (-50..+50)
        const s = this.elevationMapSize || 100;
        const tx = (mx / (s - 1)) * 100 - 50;
        const tz = (my / (s - 1)) * 100 - 50;
        return new THREE.Vector3(tx, mz, tz);
    }

    resizeFrontCamera() {
        if (!this.renderer) return;
        const parent = this.frontCameraCanvas.parentElement;
        const width = parent.clientWidth || 360;
        const height = parent.clientHeight || 232;
        if (width < 10 || height < 10) return;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    renderFrontCamera() {
        if (!this.renderer || !this.scene || !this.camera) return;

        if (this.is3DReady) {
            // Smooth third-person camera follow
            this.camera.position.lerp(this.targetCamPos, 0.07);
            this.currentLookAt.lerp(this.targetLookAt, 0.07);
            this.camera.lookAt(this.currentLookAt);
        }

        this.renderer.render(this.scene, this.camera);
    }

    setupUI() {
        document.getElementById('startExplorationBtn').onclick = () => this.start();
        document.getElementById('stopExplorationBtn').onclick = () => this.stop();
        document.getElementById('setTargetBtn').onclick = () => this.setTarget();

        // Time multiplier buttons
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mult = parseInt(btn.dataset.mult);
                this.setTimeMultiplier(mult);
            });
        });
    }

    setTimeMultiplier(mult) {
        this.timeMultiplier = mult;
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.mult) === mult);
        });
        this.addLog(`Time: ${mult}x speed`);
    }

    setTarget() {
        const x = parseFloat(document.getElementById('targetX').value);
        const z = parseFloat(document.getElementById('targetZ').value);

        this.targetPos = { x, z };
        this.addLog(`Target updated to (${x.toFixed(1)}, ${z.toFixed(1)})`, true);

        // Update task list
        const targetTask = this.tasks.find(t => t.id === 5);
        if (targetTask) {
            targetTask.name = `Navigate to Target (${x.toFixed(0)}, ${z.toFixed(0)})`;
            this.renderTasks();
        }

        // If mission is running, recalculate path
        if (this.isRunning && !this.isPaused) {
            this.addLog('Recalculating route to new target...');
            this.fetchPath();
        }
    }

    async start() {
        this.isRunning = true;
        this.speed = 0.8;
        document.getElementById('startExplorationBtn').style.display = 'none';
        document.getElementById('stopExplorationBtn').style.display = 'block';

        this.addLog('Base station established at (0,0)', true);
        this.addLog('Exploration cycle initiated', true);

        // Mark base task done
        const baseTask = this.tasks.find(t => t.id === 3);
        if (baseTask) { baseTask.done = true; this.renderTasks(); }

        // Wait a bit for imagery tiles to load
        await new Promise(resolve => setTimeout(resolve, 500));

        this.missionPhase = 'TO_TARGET';
        this.updatePhaseDisplay();

        // Check if user manually set a target (not base 0,0)
        const manualX = parseFloat(document.getElementById('targetX').value);
        const manualZ = parseFloat(document.getElementById('targetZ').value);
        const distFromBase = Math.sqrt(manualX * manualX + manualZ * manualZ);

        if (distFromBase > 0.5) {
            // User already picked a target on map - use it
            this.targetPos = { x: manualX, z: manualZ };
            this.addLog(`User target detected: (${manualX.toFixed(1)}, ${manualZ.toFixed(1)})`, true);

            const targetTask = this.tasks.find(t => t.id === 5);
            if (targetTask) {
                targetTask.name = `Navigate to Target (${manualX.toFixed(0)}, ${manualZ.toFixed(0)})`;
                this.renderTasks();
            }

            this.pathIndex = 0;
            this.path = [];
            this.currentOutboundPath = [];
            await this.fetchPath();
        } else {
            // No manual target - pick random exploration target
            await this.selectNewExplorationTarget();
        }
    }

    async detectCratersWithOpenCV(canvas, minLon, maxLon, minLat, maxLat) {
        try {
            // Convert canvas to base64
            const imageBase64 = canvas.toDataURL('image/png').split(',')[1];

            console.log('🔬 OpenCV ile krater analizi yapılıyor...');
            this.addLog('🔬 Bilgisayar görüşü ile krater analizi...', true);

            const response = await fetch(`${API_URL}/craters/detect-opencv`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: imageBase64,
                    bounds: { minLon, maxLon, minLat, maxLat }
                })
            });

            const result = await response.json();

            if (result.success && result.craters) {
                console.log(`✅ OpenCV ${result.craters.length} krater tespit etti`);
                this.addLog(`✅ OpenCV ${result.craters.length} krater buldu!`, true);

                // Convert detected craters to obstacles
                const obstacles = [];
                for (const crater of result.craters) {
                    const worldX = (crater.lon / 180) * 100;
                    const worldZ = (crater.lat / 90) * 100;
                    const radiusWorld = (crater.radius / 180) * 100;

                    obstacles.push({
                        type: 'crater',
                        position: { x: worldX, y: 0, z: worldZ },
                        radius: Math.max(0.5, radiusWorld * 50),
                        height: 1,
                        detected: true,
                        confidence: crater.confidence,
                        source: 'opencv'
                    });
                }

                return obstacles;
            } else {
                console.warn('⚠️ OpenCV detection failed:', result.error);
                return null;
            }
        } catch (error) {
            console.error('❌ OpenCV error:', error);
            return null;
        }
    }

    async detectCratersWithGPT4Vision(canvas, minLon, maxLon, minLat, maxLat) {
        try {
            // Convert canvas to base64
            const imageBase64 = canvas.toDataURL('image/png').split(',')[1];

            console.log('🤖 GPT-4 Vision ile krater analizi yapılıyor...');
            this.addLog('🤖 AI krater analizi yapılıyor...', true);

            const response = await fetch(`${API_URL}/craters/detect-ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: imageBase64,
                    bounds: { minLon, maxLon, minLat, maxLat }
                })
            });

            const result = await response.json();

            if (result.success && result.craters) {
                console.log(`✅ GPT-4 Vision detected ${result.craters.length} craters`);
                this.addLog(`✅ AI ${result.craters.length} krater tespit etti!`, true);

                // Convert detected craters to obstacles
                const obstacles = [];
                for (const crater of result.craters) {
                    const worldX = (crater.lon / 180) * 100;
                    const worldZ = (crater.lat / 90) * 100;
                    const radiusWorld = (crater.radius / 180) * 100;

                    obstacles.push({
                        type: 'crater',
                        position: { x: worldX, y: 0, z: worldZ },
                        radius: Math.max(0.5, radiusWorld * 50), // Scale radius
                        height: 1,
                        detected: true,
                        confidence: crater.confidence,
                        source: 'gpt4-vision'
                    });
                }

                return obstacles;
            } else {
                console.warn('⚠️ GPT-4 Vision detection failed:', result.error);
                this.addLog('⚠️ AI analizi başarısız, yedek yöntem kullanılıyor...');
                return null;
            }
        } catch (error) {
            console.error('❌ GPT-4 Vision error:', error);
            this.addLog('⚠️ AI analizi başarısız, yedek yöntem kullanılıyor...');
            return null;
        }
    }

    async detectCratersFromImagery() {
        // Detect craters from visible imagery tiles
        const z = Math.floor(this.zoom);
        const tilesAtZoom = Math.pow(2, z + 1);
        const tileSize = 256;

        // Get visible tiles
        const centerTileX = (this.centerX + 180) / 360 * tilesAtZoom;
        const centerTileY = (90 - this.centerY) / 180 * (tilesAtZoom / 2);

        const tileRadius = 2;
        const minTileX = Math.floor(centerTileX) - tileRadius;
        const maxTileX = Math.floor(centerTileX) + tileRadius;
        const minTileY = Math.floor(centerTileY) - tileRadius;
        const maxTileY = Math.floor(centerTileY) + tileRadius;

        // Calculate lon/lat bounds for GPT-4 Vision
        const minLon = (minTileX / tilesAtZoom) * 360 - 180;
        const maxLon = ((maxTileX + 1) / tilesAtZoom) * 360 - 180;
        const minLat = 90 - ((maxTileY + 1) / (tilesAtZoom / 2)) * 180;
        const maxLat = 90 - (minTileY / (tilesAtZoom / 2)) * 180;

        // Composite visible tiles
        const canvas = document.createElement('canvas');
        const sampleSize = 512;
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, sampleSize, sampleSize);

        const numTilesX = maxTileX - minTileX + 1;
        const numTilesY = maxTileY - minTileY + 1;
        const tileDrawSizeX = sampleSize / numTilesX;
        const tileDrawSizeY = sampleSize / numTilesY;

        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const wrappedX = ((tx % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;
                if (ty >= 0 && ty < tilesAtZoom / 2) {
                    const tile = this.tiles.get(`${z}/${wrappedX}/${ty}`);
                    if (tile) {
                        const drawX = (tx - minTileX) * tileDrawSizeX;
                        const drawY = (ty - minTileY) * tileDrawSizeY;
                        ctx.drawImage(tile, drawX, drawY, tileDrawSizeX, tileDrawSizeY);
                    }
                }
            }
        }

        // Try OpenCV first (fastest and most reliable for circles)
        const opencvCraters = await this.detectCratersWithOpenCV(canvas, minLon, maxLon, minLat, maxLat);

        if (opencvCraters && opencvCraters.length > 0) {
            // OpenCV succeeded
            this.detectedObstacles = opencvCraters;
            console.log(`🔬 Using OpenCV: detected ${this.detectedObstacles.length} craters`);
            return;
        }

        // Try GPT-4 Vision as backup
        console.log('⚠️ OpenCV found no craters, trying GPT-4 Vision...');
        const aiCraters = await this.detectCratersWithGPT4Vision(canvas, minLon, maxLon, minLat, maxLat);

        if (aiCraters && aiCraters.length > 0) {
            // GPT-4 Vision succeeded
            this.detectedObstacles = aiCraters;
            console.log(`🤖 Using GPT-4 Vision: detected ${this.detectedObstacles.length} craters`);
            return;
        }

        // Final fallback to brightness-based detection
        console.log('⚠️ AI methods unavailable, using fallback brightness detection...');

        // Get image data
        const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const data = imageData.data;

        // Calculate average brightness
        let totalBrightness = 0;
        for (let i = 0; i < data.length; i += 4) {
            totalBrightness += data[i];
        }
        const avgBrightness = totalBrightness / (data.length / 4);

        // Detect dark spots (craters) and high-gradient areas (crater edges)
        this.detectedObstacles = [];
        const gridSize = 12; // Finer sampling for better detection

        for (let y = gridSize; y < sampleSize - gridSize; y += gridSize) {
            for (let x = gridSize; x < sampleSize - gridSize; x += gridSize) {
                const idx = (y * sampleSize + x) * 4;
                const brightness = data[idx];

                // Gradient (edge) detection for crater rims
                const right = data[(y * sampleSize + x + gridSize) * 4] || brightness;
                const left = data[(y * sampleSize + x - gridSize) * 4] || brightness;
                const bottom = data[((y + gridSize) * sampleSize + x) * 4] || brightness;
                const top = data[((y - gridSize) * sampleSize + x) * 4] || brightness;
                const gradient = Math.sqrt(
                    Math.pow(right - left, 2) + Math.pow(bottom - top, 2)
                );

                // Detect dark areas (crater floors) or high-gradient areas (crater edges)
                const isDark = brightness < avgBrightness - 25;
                const isEdge = gradient > 30;

                if (isDark || isEdge) {
                    // Convert pixel to world coordinates
                    const pixelFracX = x / sampleSize;
                    const pixelFracY = y / sampleSize;

                    const tileX = minTileX + pixelFracX * numTilesX;
                    const tileY = minTileY + pixelFracY * numTilesY;

                    const obsLon = (tileX / tilesAtZoom) * 360 - 180;
                    const obsLat = 90 - (tileY / (tilesAtZoom / 2)) * 180;

                    const worldX = (obsLon / 180) * 100;
                    const worldZ = (obsLat / 90) * 100;

                    // Check distance from rover/target
                    const distToRover = Math.sqrt(
                        Math.pow(worldX - this.roverPos.x, 2) +
                        Math.pow(worldZ - this.roverPos.z, 2)
                    );
                    const distToTarget = Math.sqrt(
                        Math.pow(worldX - this.targetPos.x, 2) +
                        Math.pow(worldZ - this.targetPos.z, 2)
                    );

                    if (distToRover > 0.5 && distToTarget > 0.5) {
                        this.detectedObstacles.push({
                            type: isDark ? 'crater' : 'crater_edge',
                            position: { x: worldX, y: 0, z: worldZ },
                            radius: 1.5, // Wider safety margin
                            height: 1,
                            detected: true,
                            source: 'brightness'
                        });
                    }
                }
            }
        }

        console.log(`🔍 Fallback detection: found ${this.detectedObstacles.length} potential craters`);
    }

    async detectObstaclesFromImagery() {
        // Analyze CURRENTLY VISIBLE tiles on screen
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const sampleSize = 512;
        canvas.width = sampleSize;
        canvas.height = sampleSize;

        // Use current zoom and view
        const z = Math.floor(this.zoom);
        const tilesAtZoom = Math.pow(2, z + 1);
        const tileSize = 256;

        // Get visible tile range
        const centerTileX = (this.centerX + 180) / 360 * tilesAtZoom;
        const centerTileY = (90 - this.centerY) / 180 * (tilesAtZoom / 2);

        const tileRadius = 2;
        const minTileX = Math.floor(centerTileX) - tileRadius;
        const maxTileX = Math.floor(centerTileX) + tileRadius;
        const minTileY = Math.floor(centerTileY) - tileRadius;
        const maxTileY = Math.floor(centerTileY) + tileRadius;

        console.log(`Analyzing visible tiles at zoom ${z}, center=(${this.centerX.toFixed(2)}, ${this.centerY.toFixed(2)})`);

        // Draw loaded tiles
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, sampleSize, sampleSize);

        const tilesToAnalyze = [];
        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const wrappedX = ((tx % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;
                if (ty >= 0 && ty < tilesAtZoom / 2) {
                    const tile = this.tiles.get(`${z}/${wrappedX}/${ty}`);
                    if (tile) {
                        tilesToAnalyze.push({ x: wrappedX, y: ty, tile, origX: tx, origY: ty });
                    }
                }
            }
        }

        if (tilesToAnalyze.length === 0) {
            console.warn('No tiles to analyze!');
            return;
        }

        // Composite tiles
        const numTilesX = maxTileX - minTileX + 1;
        const numTilesY = maxTileY - minTileY + 1;
        const tileDrawSizeX = sampleSize / numTilesX;
        const tileDrawSizeY = sampleSize / numTilesY;

        tilesToAnalyze.forEach(({ tile, origX, origY }) => {
            const drawX = (origX - minTileX) * tileDrawSizeX;
            const drawY = (origY - minTileY) * tileDrawSizeY;
            ctx.drawImage(tile, drawX, drawY, tileDrawSizeX, tileDrawSizeY);
        });

        console.log(`Composited ${tilesToAnalyze.length} tiles for analysis`);

        // Get image data
        const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const data = imageData.data;

        // Calculate average brightness
        let totalBrightness = 0;
        let count = 0;
        for (let y = 0; y < sampleSize; y++) {
            for (let x = 0; x < sampleSize; x++) {
                totalBrightness += data[(y * sampleSize + x) * 4];
                count++;
            }
        }
        const avgBrightness = totalBrightness / count;
        console.log(`Average brightness: ${avgBrightness.toFixed(1)}`);

        // Calculate route corridor - only detect obstacles near the path
        const roverLL = this.worldToLonLat(this.roverPos.x, this.roverPos.z);
        const targetLL = this.worldToLonLat(this.targetPos.x, this.targetPos.z);

        console.log(`Route: rover=(${roverLL.lon.toFixed(3)}, ${roverLL.lat.toFixed(3)}) to target=(${targetLL.lon.toFixed(3)}, ${targetLL.lat.toFixed(3)})`);

        // Detect obstacles - VERY SENSITIVE to detect all terrain features
        this.detectedObstacles = [];
        const gridSize = 6; // Fine sampling for detailed terrain

        for (let y = gridSize; y < sampleSize - gridSize; y += gridSize) {
            for (let x = gridSize; x < sampleSize - gridSize; x += gridSize) {
                // Convert pixel to lon/lat first to check if it's near the route
                const pixelFracX = x / sampleSize;
                const pixelFracY = y / sampleSize;

                const tileX = minTileX + pixelFracX * numTilesX;
                const tileY = minTileY + pixelFracY * numTilesY;

                const obsLon = (tileX / tilesAtZoom) * 360 - 180;
                const obsLat = 90 - (tileY / (tilesAtZoom / 2)) * 180;

                // Check if this point is near the route corridor
                // Calculate distance to the line from rover to target
                const t = Math.max(0, Math.min(1,
                    ((obsLon - roverLL.lon) * (targetLL.lon - roverLL.lon) +
                     (obsLat - roverLL.lat) * (targetLL.lat - roverLL.lat)) /
                    (Math.pow(targetLL.lon - roverLL.lon, 2) + Math.pow(targetLL.lat - roverLL.lat, 2))
                ));
                const closestLon = roverLL.lon + t * (targetLL.lon - roverLL.lon);
                const closestLat = roverLL.lat + t * (targetLL.lat - roverLL.lat);
                const distToRoute = Math.sqrt(
                    Math.pow(obsLon - closestLon, 2) + Math.pow(obsLat - closestLat, 2)
                );

                // Only analyze points within corridor (adjust corridor width based on zoom)
                const corridorWidth = 10 / this.zoom; // Narrower at higher zoom
                if (distToRoute > corridorWidth) {
                    continue; // Skip points outside route corridor
                }

                const idx = (y * sampleSize + x) * 4;
                const brightness = data[idx];

                // Multi-scale edge detection for better feature detection
                const right = data[idx + 4] || brightness;
                const left = data[idx - 4] || brightness;
                const bottom = data[(y + 1) * sampleSize * 4 + x * 4] || brightness;
                const top = data[(y - 1) * sampleSize * 4 + x * 4] || brightness;

                // Also check diagonal gradients for slopes
                const topRight = data[((y - 1) * sampleSize + x + 1) * 4] || brightness;
                const topLeft = data[((y - 1) * sampleSize + x - 1) * 4] || brightness;
                const bottomRight = data[((y + 1) * sampleSize + x + 1) * 4] || brightness;
                const bottomLeft = data[((y + 1) * sampleSize + x - 1) * 4] || brightness;

                const gradientX = Math.abs(right - left);
                const gradientY = Math.abs(bottom - top);
                const gradientDiag1 = Math.abs(topRight - bottomLeft);
                const gradientDiag2 = Math.abs(topLeft - bottomRight);
                const gradient = Math.sqrt(gradientX * gradientX + gradientY * gradientY);
                const gradientDiag = Math.max(gradientDiag1, gradientDiag2);

                // MUCH MORE SENSITIVE - detect subtle features
                const isDarkCrater = brightness < (avgBrightness - 20); // Detect even slightly dark areas
                const isBrightRock = brightness > (avgBrightness + 20); // Detect even slightly bright areas
                const isHighContrast = gradient > 25; // Much lower threshold
                const isDiagonalSlope = gradientDiag > 25; // Detect slopes
                const isMediumContrast = gradient > 15; // Even subtle edges

                if (isDarkCrater || isBrightRock || isHighContrast || isDiagonalSlope || isMediumContrast) {
                    // Already have obsLon, obsLat from corridor check above
                    // Convert lon/lat to world coordinates
                    const worldX = (obsLon / 180) * 100;
                    const worldZ = (obsLat / 90) * 100;

                    // Check distance from rover/target
                    const distToRover = Math.sqrt(
                        Math.pow(worldX - this.roverPos.x, 2) +
                        Math.pow(worldZ - this.roverPos.z, 2)
                    );
                    const distToTarget = Math.sqrt(
                        Math.pow(worldX - this.targetPos.x, 2) +
                        Math.pow(worldZ - this.targetPos.z, 2)
                    );

                    if (distToRover > 0.25 && distToTarget > 0.25) {
                        // Classify obstacle based on features
                        let obstacleType = 'edge';
                        let obstacleRadius = 0.4;

                        if (isDarkCrater) {
                            obstacleType = 'crater';
                            obstacleRadius = 0.6; // Craters are larger hazards
                        } else if (isBrightRock) {
                            obstacleType = 'rock';
                            obstacleRadius = 0.5;
                        } else if (isDiagonalSlope) {
                            obstacleType = 'slope';
                            obstacleRadius = 0.45;
                        } else if (isHighContrast) {
                            obstacleType = 'edge';
                            obstacleRadius = 0.4;
                        } else {
                            obstacleType = 'subtle';
                            obstacleRadius = 0.35;
                        }

                        this.detectedObstacles.push({
                            type: obstacleType,
                            position: { x: worldX, y: 0, z: worldZ },
                            radius: obstacleRadius,
                            height: isDarkCrater ? 1 : 2,
                            brightness: brightness,
                            gradient: gradient,
                            detected: true
                        });
                    }
                }
            }
        }

        // Limit obstacles - allow more for detailed terrain mapping
        if (this.detectedObstacles.length > 200) {
            // Keep most significant obstacles (largest radius first)
            this.detectedObstacles.sort((a, b) => b.radius - a.radius);
            this.detectedObstacles = this.detectedObstacles.slice(0, 200);
        }

        console.log(`🔍 Detected ${this.detectedObstacles.length} obstacles from visible tiles`);
        if (this.detectedObstacles.length > 0) {
            console.log('First obstacle:', this.detectedObstacles[0]);
            const roverLL = this.worldToLonLat(this.roverPos.x, this.roverPos.z);
            console.log(`Rover: world=(${this.roverPos.x}, ${this.roverPos.z}), lonlat=(${roverLL.lon.toFixed(2)}, ${roverLL.lat.toFixed(2)})`);
        }
    }

    showDemOverlay(title, sub) {
        const overlay = document.getElementById('demLoadingOverlay');
        const titleEl = document.getElementById('demLoadingTitle');
        const subEl = document.getElementById('demLoadingSub');
        if (overlay) overlay.style.display = 'flex';
        if (titleEl) titleEl.textContent = title || 'DEM Yukseklik Verisi Aliniyor';
        if (subEl) subEl.textContent = sub || 'Lutfen bekleyin...';
    }

    hideDemOverlay() {
        const overlay = document.getElementById('demLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    async fetchPath() {
        try {
            console.log(`🛤️ Requesting path from (${this.roverPos.x.toFixed(1)}, ${this.roverPos.z.toFixed(1)}) to (${this.targetPos.x.toFixed(1)}, ${this.targetPos.z.toFixed(1)})`);

            // Show DEM loading overlay on map
            this.showDemOverlay('Arazi Analizi Yapiliyor', 'Uydu goruntuleri taranarak kraterler tespit ediliyor...');

            // First, detect craters from visible imagery
            await this.detectCratersFromImagery();

            // Calculate bounds for elevation query
            const roverLL = this.worldToLonLat(this.roverPos.x, this.roverPos.z);
            const targetLL = this.worldToLonLat(this.targetPos.x, this.targetPos.z);

            const padding = 3; // degrees of padding around route
            const minLon = Math.min(roverLL.lon, targetLL.lon) - padding;
            const maxLon = Math.max(roverLL.lon, targetLL.lon) + padding;
            const minLat = Math.min(roverLL.lat, targetLL.lat) - padding;
            const maxLat = Math.max(roverLL.lat, targetLL.lat) + padding;

            // Fetch REAL elevation data from NASA LOLA DEM API
            this.showDemOverlay('NASA LOLA DEM Verisi Aliniyor', 'Yukseklik haritasi indiriliyor... Bu islem biraz surabilir.');
            this.addLog('🛰️ NASA LOLA DEM yükseklik verisi alınıyor...', true);
            let elevationGrid = null;
            let actualGridSize = 40;

            try {
                const elevRes = await fetch(`${API_URL}/elevation/grid`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        minLon, maxLon, minLat, maxLat,
                        gridSize: 40
                    })
                });

                const elevData = await elevRes.json();

                if (elevData.success && elevData.grid) {
                    elevationGrid = elevData.grid;
                    actualGridSize = elevData.gridSize; // Upsampled size from backend
                    this.addLog(`✅ LOLA DEM: ${elevData.sampledRows} satır, ${elevData.minElevation?.toFixed(0)}m - ${elevData.maxElevation?.toFixed(0)}m`, true);
                    console.log(`✅ LOLA DEM loaded: ${actualGridSize}x${actualGridSize} grid`);
                } else {
                    console.warn('LOLA DEM failed:', elevData.error);
                    this.addLog('⚠️ LOLA DEM alınamadı, tile verisi kullanılıyor...');
                }
            } catch (e) {
                console.error('LOLA DEM fetch error:', e);
                this.addLog('⚠️ LOLA DEM bağlantı hatası, tile verisi kullanılıyor...');
            }

            // If LOLA DEM failed, fall back to tile brightness sampling
            if (!elevationGrid) {
                const gridSize = 40;
                actualGridSize = gridSize;
                elevationGrid = [];
                let sampledCount = 0;

                for (let i = 0; i < gridSize; i++) {
                    const row = [];
                    for (let j = 0; j < gridSize; j++) {
                        const lon = minLon + (maxLon - minLon) * (j / (gridSize - 1));
                        const lat = minLat + (maxLat - minLat) * (i / (gridSize - 1));
                        const elevation = this.getElevationAt(lon, lat);
                        row.push(elevation !== null ? elevation : 0);
                        if (elevation !== null) sampledCount++;
                    }
                    elevationGrid.push(row);
                }
                console.log(`📊 Fallback: sampled ${sampledCount}/${gridSize * gridSize} points from tile brightness`);
            }

            // Send detected craters as obstacles
            if (this.detectedObstacles.length > 0) {
                await fetch(`${API_URL}/obstacles/set`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ obstacles: this.detectedObstacles })
                });
                console.log(`📡 Sent ${this.detectedObstacles.length} detected craters to pathfinder`);
            }

            this.showDemOverlay('Guvenli Rota Hesaplaniyor', 'A* algoritmasi ile en guvenli yol bulunuyor...');
            this.addLog('🧭 Güvenli rota hesaplanıyor...');

            const res = await fetch(`${API_URL}/pathfinding/find`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    start: { x: this.roverPos.x, z: this.roverPos.z },
                    end: { x: this.targetPos.x, z: this.targetPos.z },
                    elevationGrid: elevationGrid,
                    gridBounds: { minLon, maxLon, minLat, maxLat }
                })
            });

            const data = await res.json();

            if (data.success && data.path && data.path.length > 0) {
                this.path = data.path;
                this.pathIndex = 0;
                console.log(`✅ Path calculated: ${this.path.length} waypoints`);

                // Save outbound path for exploration
                if (this.missionPhase === 'TO_TARGET') {
                    this.currentOutboundPath = [...this.path];
                }

                // Build 3D terrain mesh from elevation data
                if (elevationGrid && elevationGrid.length > 0) {
                    const gridSize = actualGridSize;

                    // Render resolution for 3D mesh
                    const renderRes = 200;

                    // Map world coords to the expanded grid used by the 3D mesh
                    this.worldToGridCoords = (wx, wz) => {
                        const ll = this.worldToLonLat(wx, wz);
                        const maxIdx = renderRes - 1;
                        const gx = ((ll.lon - minLon) / (maxLon - minLon)) * maxIdx;
                        const gy = ((ll.lat - minLat) / (maxLat - minLat)) * maxIdx;
                        return { gx: Math.max(0, Math.min(maxIdx, gx)), gy: Math.max(0, Math.min(maxIdx, gy)) };
                    };

                    // Find min/max elevation for normalization
                    let minElev = Infinity;
                    let maxElev = -Infinity;
                    for (let i = 0; i < gridSize; i++) {
                        for (let j = 0; j < gridSize; j++) {
                            minElev = Math.min(minElev, elevationGrid[i][j]);
                            maxElev = Math.max(maxElev, elevationGrid[i][j]);
                        }
                    }
                    const elevRange = maxElev - minElev;

                    console.log(`📊 Elevation range: ${minElev.toFixed(0)}m to ${maxElev.toFixed(0)}m (${elevRange.toFixed(0)}m total)`);

                    // Expand/resample grid to renderRes x renderRes for detailed 3D
                    const maxIdx = renderRes - 1;
                    const expandedGrid = [];
                    for (let y = 0; y < renderRes; y++) {
                        const row = [];
                        for (let x = 0; x < renderRes; x++) {
                            const srcX = (x / maxIdx) * (gridSize - 1);
                            const srcY = (y / maxIdx) * (gridSize - 1);

                            const x0 = Math.floor(srcX);
                            const y0 = Math.floor(srcY);
                            const x1 = Math.min(x0 + 1, gridSize - 1);
                            const y1 = Math.min(y0 + 1, gridSize - 1);
                            const tx = srcX - x0;
                            const ty = srcY - y0;

                            const z00 = elevationGrid[y0][x0];
                            const z10 = elevationGrid[y0][x1];
                            const z01 = elevationGrid[y1][x0];
                            const z11 = elevationGrid[y1][x1];

                            const a0 = z00 * (1 - tx) + z10 * tx;
                            const a1 = z01 * (1 - tx) + z11 * tx;
                            let z = a0 * (1 - ty) + a1 * ty;

                            // Normalize to relative elevation
                            z = elevRange > 0 ? (z - minElev) / elevRange : 0.5;

                            // Stronger exaggeration so craters/hills are visible
                            const scaleFactor = Math.min(8, Math.max(1.5, elevRange / 300));
                            z = (z - 0.5) * scaleFactor;

                            row.push(z);
                        }
                        expandedGrid.push(row);
                    }

                    // Light Gaussian smoothing (preserve crater detail)
                    const smoothedGrid = [];
                    for (let y = 0; y < renderRes; y++) {
                        const row = [];
                        for (let x = 0; x < renderRes; x++) {
                            let sum = 0;
                            let weight = 0;
                            for (let dy = -1; dy <= 1; dy++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    const ny = Math.max(0, Math.min(maxIdx, y + dy));
                                    const nx = Math.max(0, Math.min(maxIdx, x + dx));
                                    const w = (dx === 0 && dy === 0) ? 6 : (dx !== 0 && dy !== 0) ? 1 : 2;
                                    sum += expandedGrid[ny][nx] * w;
                                    weight += w;
                                }
                            }
                            row.push(sum / weight);
                        }
                        smoothedGrid.push(row);
                    }

                    this.build3DTerrain(smoothedGrid, renderRes);

                    // Add 3D path line on terrain
                    if (this.pathLine3D) this.scene.remove(this.pathLine3D);
                    const pathPoints = [];
                    for (const wp of this.path) {
                        const gp = this.worldToGridCoords(wp.x, wp.z);
                        const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
                        const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);
                        pathPoints.push(new THREE.Vector3(p3d.x, p3d.y + 0.15, p3d.z));
                    }
                    if (pathPoints.length > 1) {
                        const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPoints);
                        const pathMat = new THREE.LineBasicMaterial({ color: 0xc678dd, linewidth: 2 });
                        this.pathLine3D = new THREE.Line(pathGeom, pathMat);
                        this.scene.add(this.pathLine3D);
                    }

                    // Add 3D target marker
                    if (this.targetMarker3D) this.scene.remove(this.targetMarker3D);
                    const tgp = this.worldToGridCoords(this.targetPos.x, this.targetPos.z);
                    const tze = this.elevBilinear(this.elevationMapData, tgp.gx, tgp.gy);
                    const t3d = this.getMap3DCoords(tgp.gx, tgp.gy, tze);
                    const markerGroup = new THREE.Group();
                    const pole = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.06, 0.06, 2.5, 8),
                        new THREE.MeshStandardMaterial({ color: 0xf0c040 })
                    );
                    pole.position.set(0, 1.25, 0);
                    markerGroup.add(pole);
                    const beacon = new THREE.Mesh(
                        new THREE.OctahedronGeometry(0.35, 0),
                        new THREE.MeshStandardMaterial({ color: 0xf0c040, emissive: 0x805000, emissiveIntensity: 0.6 })
                    );
                    beacon.position.set(0, 2.7, 0);
                    markerGroup.add(beacon);
                    const beaconLight = new THREE.PointLight(0xf0c040, 0.8, 15);
                    beaconLight.position.set(0, 2.7, 0);
                    markerGroup.add(beaconLight);
                    markerGroup.position.set(t3d.x, t3d.y, t3d.z);
                    this.targetMarker3D = markerGroup;
                    this.scene.add(this.targetMarker3D);

                    // Position camera for initial third-person overview
                    const rGP = this.worldToGridCoords(this.roverPos.x, this.roverPos.z);
                    const rElev = this.elevBilinear(this.elevationMapData, rGP.gx, rGP.gy);
                    const r3d = this.getMap3DCoords(rGP.gx, rGP.gy, rElev);
                    this.targetCamPos.set(r3d.x, r3d.y + 0.7, r3d.z - 1.5);
                    this.targetLookAt.set(r3d.x, r3d.y + 0.1, r3d.z);
                    this.camera.position.copy(this.targetCamPos);
                    this.currentLookAt.copy(this.targetLookAt);

                    // Show rover at start position
                    const rig = this.ensureRoverRig();
                    rig.visible = true;
                    rig.position.set(r3d.x, r3d.y, r3d.z);

                    // Add base marker in 3D
                    this.addBaseMarker3D();

                    // Spawn obstacle rocks AFTER terrain is built so 3D meshes are created
                    this.spawnPathObstacles();
                }

                this.addLog(`✅ Güvenli rota bulundu (${this.path.length} waypoint)`, true);
                this.hideDemOverlay();
            } else {
                console.error('❌ Path calculation failed:', data);
                this.addLog('❌ Rota hesaplanamadı');
                this.hideDemOverlay();
            }
        } catch (error) {
            console.error('Path error:', error);
            this.addLog('ERROR: Path planning failed');
            this.hideDemOverlay();
        }
    }

    pause() {
        this.isPaused = !this.isPaused;
        document.getElementById('stopExplorationBtn').textContent = this.isPaused ? 'Devam Et' : 'Kesfi Durdur';
        this.addLog(this.isPaused ? 'Mission paused' : 'Mission resumed', !this.isPaused);
    }

    stop() {
        if (this.isRunning && !this.isPaused) {
            this.pause();
        } else if (this.isPaused) {
            this.pause();
        } else {
            this.reset();
        }
    }

    reset() {
        this.isRunning = false;
        this.isPaused = false;
        this.speed = 0;
        this.pathIndex = 0;
        this.roverPos = { x: 0, z: 0 };
        this.targetPos = { x: 0, z: 0 };
        this.heading = 0;
        this.path = [];

        // Reset exploration state
        this.missionPhase = 'IDLE';
        this.exploredPoints = [];
        this.missionCount = 0;
        this.currentExplorationId = null;
        this.currentOutboundPath = [];
        this.usedNames = new Set();
        this.timeMultiplier = 1;

        // Reset time buttons UI
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.mult) === 1);
        });

        // Center camera back on base
        const baseLL = this.worldToLonLat(0, 0);
        this.centerX = baseLL.lon;
        this.centerY = baseLL.lat;
        this.zoom = 6;

        // Reset 3D elements
        if (this.roverRig) this.roverRig.visible = false;
        if (this.pathLine3D) { this.scene.remove(this.pathLine3D); this.pathLine3D = null; }
        if (this.targetMarker3D) { this.scene.remove(this.targetMarker3D); this.targetMarker3D = null; }
        if (this.baseMarker3D) { this.scene.remove(this.baseMarker3D); this.baseMarker3D = null; }
        for (const m of this.exploredMarkers3D) this.scene.remove(m);
        this.exploredMarkers3D = [];
        for (const l of this.savedRouteLines3D) this.scene.remove(l);
        this.savedRouteLines3D = [];
        this.clearPathObstacles();
        this.obstacleAlertActive = false;
        this.obstacleAvoidanceCount = 0;

        // Hide obstacle alert if showing
        const alert = document.getElementById('obstacleAlert');
        if (alert) alert.style.display = 'none';

        document.getElementById('startExplorationBtn').style.display = 'block';
        document.getElementById('stopExplorationBtn').style.display = 'none';
        document.getElementById('stopExplorationBtn').textContent = 'Kesfi Durdur';

        // Reset UI panels
        this.updateExplorationPanel();
        this.updatePhaseDisplay();
        const badge = document.getElementById('exploredCountBadge');
        if (badge) badge.textContent = '0';

        // Reset target inputs
        document.getElementById('targetX').value = '0.0';
        document.getElementById('targetZ').value = '0.0';

        this.addLog('System reset');
        this.updateUI();
    }

    async selectNewExplorationTarget() {
        const randCoord = () => (Math.random() - 0.5) * 8;
        let newTarget;
        let attempts = 0;
        do {
            newTarget = { x: randCoord(), z: randCoord() };
            attempts++;
            if (attempts > 100) break;

            // Must be at least 2 units from base
            const distFromBase = Math.sqrt(
                Math.pow(newTarget.x - this.basePos.x, 2) +
                Math.pow(newTarget.z - this.basePos.z, 2)
            );
            if (distFromBase < 2) continue;

            // Must be at least 1.5 units from all explored points
            let tooClose = false;
            for (const ep of this.exploredPoints) {
                const d = Math.sqrt(
                    Math.pow(newTarget.x - ep.pos.x, 2) +
                    Math.pow(newTarget.z - ep.pos.z, 2)
                );
                if (d < 1.5) { tooClose = true; break; }
            }
            if (tooClose) continue;

            break;
        } while (true);

        this.targetPos = newTarget;
        document.getElementById('targetX').value = newTarget.x.toFixed(1);
        document.getElementById('targetZ').value = newTarget.z.toFixed(1);

        // Update task
        const targetTask = this.tasks.find(t => t.id === 5);
        if (targetTask) {
            targetTask.name = `Navigate to Target (${newTarget.x.toFixed(0)}, ${newTarget.z.toFixed(0)})`;
            this.renderTasks();
        }

        this.addLog(`New exploration target: (${newTarget.x.toFixed(1)}, ${newTarget.z.toFixed(1)})`, true);
        this.pathIndex = 0;
        this.path = [];
        this.currentOutboundPath = [];
        await this.fetchPath();
    }

    generateLunarName() {
        let name;
        let attempts = 0;
        do {
            const prefix = this.lunarPrefixes[Math.floor(Math.random() * this.lunarPrefixes.length)];
            const suffix = this.lunarSuffixes[Math.floor(Math.random() * this.lunarSuffixes.length)];
            name = `${prefix} ${suffix}`;
            attempts++;
            if (attempts > 50) {
                name = `Site-${this.exploredPoints.length + 1}`;
                break;
            }
        } while (this.usedNames.has(name));
        this.usedNames.add(name);
        return name;
    }

    onArriveAtTarget() {
        this.missionPhase = 'AT_TARGET';
        this.updatePhaseDisplay();

        const name = this.generateLunarName();
        const color = this.routeColors[this.exploredPoints.length % this.routeColors.length];
        const distFromBase = Math.sqrt(
            Math.pow(this.roverPos.x - this.basePos.x, 2) +
            Math.pow(this.roverPos.z - this.basePos.z, 2)
        );

        const point = {
            id: this.exploredPoints.length,
            name: name,
            pos: { x: this.roverPos.x, z: this.roverPos.z },
            outboundPath: [...this.currentOutboundPath],
            returnPath: [],
            color: color,
            distFromBase: distFromBase
        };

        this.exploredPoints.push(point);
        this.currentExplorationId = point.id;

        // Add 3D marker
        this.addExploredPointMarker3D(point);

        // Show arrival overlay
        const overlay = document.getElementById('arrivalOverlay');
        const sub = document.getElementById('arrivalSub');
        const title = overlay.querySelector('.arrival-title');
        if (title) title.textContent = name;
        if (sub) sub.textContent = `Kesfedildi! ${distFromBase.toFixed(1)} birim uzaklikta. Base'e donuluyor...`;
        overlay.style.display = 'flex';

        this.addLog(`Arrived at ${name}!`, true);
        this.updateExplorationPanel();

        // After 2 seconds, start returning to base
        setTimeout(() => {
            overlay.style.display = 'none';
            this.missionPhase = 'RETURNING';
            this.updatePhaseDisplay();
            this.targetPos = { ...this.basePos };
            document.getElementById('targetX').value = this.basePos.x.toFixed(1);
            document.getElementById('targetZ').value = this.basePos.z.toFixed(1);

            // Update task
            const returnTask = this.tasks.find(t => t.id === 6);
            if (returnTask) {
                returnTask.name = 'Returning to Base...';
                returnTask.active = true;
                this.renderTasks();
            }

            this.addLog('Returning to base...', true);
            this.fetchPath();
        }, 2000);
    }

    onArriveAtBase() {
        this.missionPhase = 'AT_BASE';
        this.updatePhaseDisplay();
        this.missionCount++;

        // Save return path
        const point = this.exploredPoints.find(p => p.id === this.currentExplorationId);
        if (point) {
            point.returnPath = [...this.path];
            this.addSavedRouteLines3D(point);
        }

        this.addLog(`Back at base! Missions completed: ${this.missionCount}`, true);

        // Update explored count badge
        const badge = document.getElementById('exploredCountBadge');
        if (badge) badge.textContent = this.exploredPoints.length;

        this.updateExplorationPanel();

        // Update task
        const returnTask = this.tasks.find(t => t.id === 6);
        if (returnTask) { returnTask.done = true; returnTask.active = false; }
        const navTask = this.tasks.find(t => t.id === 5);
        if (navTask) { navTask.done = true; }
        this.renderTasks();

        // After 1 second, select new target and continue
        setTimeout(async () => {
            // Reset tasks for next cycle
            const navTask = this.tasks.find(t => t.id === 5);
            if (navTask) { navTask.done = false; navTask.active = true; navTask.name = 'Navigate to Target'; }
            const returnTask = this.tasks.find(t => t.id === 6);
            if (returnTask) { returnTask.done = false; returnTask.active = false; returnTask.name = 'Return to Base'; }
            this.renderTasks();

            this.missionPhase = 'TO_TARGET';
            this.updatePhaseDisplay();
            await this.selectNewExplorationTarget();
        }, 1000);
    }

    navigateToSavedPoint(point) {
        if (!point || !point.outboundPath || point.outboundPath.length === 0) {
            this.addLog('No saved route for this point');
            return;
        }

        this.path = [...point.outboundPath];
        this.pathIndex = 0;
        this.targetPos = { ...point.pos };
        this.missionPhase = 'TO_TARGET';
        this.currentExplorationId = point.id;
        this.currentOutboundPath = [...point.outboundPath];
        this.updatePhaseDisplay();

        document.getElementById('targetX').value = point.pos.x.toFixed(1);
        document.getElementById('targetZ').value = point.pos.z.toFixed(1);

        if (!this.isRunning) {
            this.isRunning = true;
            this.speed = 0.8;
            document.getElementById('startExplorationBtn').style.display = 'none';
            document.getElementById('stopExplorationBtn').style.display = 'block';
        }

        this.addLog(`Navigating to ${point.name} via saved route`, true);
    }

    updateExplorationPanel() {
        const list = document.getElementById('exploredPointsList');
        if (!list) return;

        if (this.exploredPoints.length === 0) {
            list.innerHTML = '<div class="empty-msg">Henuz kesfedilen nokta yok</div>';
            return;
        }

        list.innerHTML = '';
        for (const point of this.exploredPoints) {
            const item = document.createElement('div');
            item.className = 'explored-point-item';
            item.innerHTML = `
                <div class="explored-point-color" style="background: ${point.color}"></div>
                <div style="flex:1; min-width:0">
                    <div class="explored-point-name">${point.name}</div>
                    <div class="explored-point-coords">(${point.pos.x.toFixed(1)}, ${point.pos.z.toFixed(1)}) - ${point.distFromBase.toFixed(1)}u</div>
                </div>
            `;
            list.appendChild(item);
        }
    }

    updatePhaseDisplay() {
        const phaseEl = document.getElementById('missionPhaseDisplay');
        if (!phaseEl) return;

        const phaseLabels = {
            'IDLE': 'Beklemede',
            'TO_TARGET': 'Hedefe Gidiyor',
            'AT_TARGET': 'Kesfediliyor',
            'RETURNING': 'Base\'e Donuyor',
            'AT_BASE': 'Base\'de'
        };
        phaseEl.textContent = phaseLabels[this.missionPhase] || this.missionPhase;

        // Also update telemetry strip
        const telemPhase = document.getElementById('telemPhase');
        if (telemPhase) telemPhase.textContent = this.missionPhase;
        const telemExplored = document.getElementById('telemExplored');
        if (telemExplored) telemExplored.textContent = this.exploredPoints.length;
    }

    // === 3D HELPER METHODS ===

    addBaseMarker3D() {
        if (!this.is3DReady || !this.worldToGridCoords) return;
        if (this.baseMarker3D) this.scene.remove(this.baseMarker3D);

        const gp = this.worldToGridCoords(this.basePos.x, this.basePos.z);
        const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
        const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);

        const group = new THREE.Group();

        // Cyan platform
        const platform = new THREE.Mesh(
            new THREE.CylinderGeometry(0.8, 1.0, 0.2, 16),
            new THREE.MeshStandardMaterial({ color: 0x00cccc, emissive: 0x004444, emissiveIntensity: 0.4 })
        );
        platform.position.set(0, 0.1, 0);
        group.add(platform);

        // Antenna mast
        const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.06, 2.5, 8),
            new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6, roughness: 0.3 })
        );
        mast.position.set(0, 1.45, 0);
        group.add(mast);

        // Antenna dish
        const dish = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.5, roughness: 0.3 })
        );
        dish.position.set(0, 2.7, 0);
        dish.rotation.x = Math.PI;
        group.add(dish);

        // Beacon light
        const light = new THREE.PointLight(0x00cccc, 1.0, 20);
        light.position.set(0, 3.0, 0);
        group.add(light);

        group.position.set(p3d.x, p3d.y, p3d.z);
        this.baseMarker3D = group;
        this.scene.add(this.baseMarker3D);
    }

    addExploredPointMarker3D(point) {
        if (!this.is3DReady || !this.worldToGridCoords) return;

        const gp = this.worldToGridCoords(point.pos.x, point.pos.z);
        const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
        const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);

        const color = new THREE.Color(point.color);
        const group = new THREE.Group();

        // Pole
        const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.04, 2.0, 8),
            new THREE.MeshStandardMaterial({ color: color })
        );
        pole.position.set(0, 1.0, 0);
        group.add(pole);

        // Sphere at top
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.25, 12, 12),
            new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.4 })
        );
        sphere.position.set(0, 2.2, 0);
        group.add(sphere);

        // Small light
        const light = new THREE.PointLight(color.getHex(), 0.5, 10);
        light.position.set(0, 2.2, 0);
        group.add(light);

        group.position.set(p3d.x, p3d.y, p3d.z);
        this.exploredMarkers3D.push(group);
        this.scene.add(group);
    }

    addSavedRouteLines3D(point) {
        if (!this.is3DReady || !this.worldToGridCoords) return;

        const color = new THREE.Color(point.color);

        // Outbound path (solid line)
        if (point.outboundPath && point.outboundPath.length > 1) {
            const pts = [];
            for (const wp of point.outboundPath) {
                const gp = this.worldToGridCoords(wp.x, wp.z);
                const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
                const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);
                pts.push(new THREE.Vector3(p3d.x, p3d.y + 0.1, p3d.z));
            }
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5 });
            const line = new THREE.Line(geom, mat);
            this.savedRouteLines3D.push(line);
            this.scene.add(line);
        }

        // Return path (same color, slightly offset)
        if (point.returnPath && point.returnPath.length > 1) {
            const pts = [];
            for (const wp of point.returnPath) {
                const gp = this.worldToGridCoords(wp.x, wp.z);
                const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
                const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);
                pts.push(new THREE.Vector3(p3d.x, p3d.y + 0.12, p3d.z));
            }
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.3 });
            const line = new THREE.Line(geom, mat);
            this.savedRouteLines3D.push(line);
            this.scene.add(line);
        }
    }

    // === OBSTACLE SPAWNING & AVOIDANCE ===

    spawnPathObstacles() {
        // Remove old obstacle meshes
        for (const obs of this.pathObstacles) {
            if (obs.mesh3D) this.scene.remove(obs.mesh3D);
        }
        this.pathObstacles = [];

        if (!this.path || this.path.length < 5) return;

        // Spawn 1-2 rocks along the path
        const numObstacles = 1 + Math.floor(Math.random() * 2);
        const minIdx = Math.floor(this.path.length * 0.15); // Not too close to start
        const maxIdx = Math.floor(this.path.length * 0.85); // Not too close to end

        for (let i = 0; i < numObstacles; i++) {
            const pathIdx = minIdx + Math.floor(Math.random() * (maxIdx - minIdx));
            const wp = this.path[pathIdx];

            // Place directly on path (tiny offset for natural look)
            const offsetDist = Math.random() * 0.03;
            const offsetAngle = Math.random() * Math.PI * 2;
            const ox = wp.x + Math.cos(offsetAngle) * offsetDist;
            const oz = wp.z + Math.sin(offsetAngle) * offsetDist;

            const radius = 0.15 + Math.random() * 0.25; // 0.15 - 0.40 world units

            const obstacle = {
                pos: { x: ox, z: oz },
                radius: radius,
                pathIdx: pathIdx,
                mesh3D: null,
                detected: false
            };

            // Create 3D rock mesh
            if (this.is3DReady && this.worldToGridCoords) {
                obstacle.mesh3D = this.createRock3D(obstacle);
            }

            this.pathObstacles.push(obstacle);
        }

        console.log(`Spawned ${this.pathObstacles.length} path obstacles`);
    }

    createRock3D(obstacle) {
        const gp = this.worldToGridCoords(obstacle.pos.x, obstacle.pos.z);
        const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
        const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);

        const group = new THREE.Group();

        // Rock material - dark lunar gray
        const rockMat = new THREE.MeshStandardMaterial({
            color: 0x3a3a3c,
            roughness: 0.95,
            metalness: 0.05,
        });

        // Main rock body - irregular using dodecahedron
        const scale = obstacle.radius * 3;
        const mainRock = new THREE.Mesh(
            new THREE.DodecahedronGeometry(scale, 1),
            rockMat
        );
        // Squash and randomize for natural look
        mainRock.scale.set(
            0.7 + Math.random() * 0.6,
            0.4 + Math.random() * 0.4,
            0.7 + Math.random() * 0.6
        );
        mainRock.rotation.set(
            Math.random() * 0.5,
            Math.random() * Math.PI * 2,
            Math.random() * 0.3
        );
        mainRock.position.y = scale * 0.2;
        group.add(mainRock);

        // Smaller scattered rocks around the main one
        const smallRockMat = new THREE.MeshStandardMaterial({
            color: 0x2e2e30, roughness: 0.98, metalness: 0.02
        });
        const numSmall = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numSmall; i++) {
            const sr = scale * (0.2 + Math.random() * 0.3);
            const smallRock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(sr, 0),
                smallRockMat
            );
            const angle = Math.random() * Math.PI * 2;
            const dist = scale * (0.8 + Math.random() * 0.6);
            smallRock.position.set(
                Math.cos(angle) * dist,
                sr * 0.3,
                Math.sin(angle) * dist
            );
            smallRock.rotation.set(Math.random(), Math.random(), Math.random());
            smallRock.scale.set(
                0.6 + Math.random() * 0.8,
                0.4 + Math.random() * 0.5,
                0.6 + Math.random() * 0.8
            );
            group.add(smallRock);
        }

        group.position.set(p3d.x, p3d.y, p3d.z);
        this.scene.add(group);
        return group;
    }

    checkObstacleAhead() {
        if (this.obstacleAlertActive) return false;
        if (!this.path || this.pathIndex >= this.path.length) return false;

        // Check distance to each undetected obstacle
        const detectionRange = 0.6; // "front camera" detection range in world units
        for (const obs of this.pathObstacles) {
            if (obs.detected) continue;

            const dx = obs.pos.x - this.roverPos.x;
            const dz = obs.pos.z - this.roverPos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < detectionRange) {
                obs.detected = true;
                this.onObstacleDetected(obs);
                return true;
            }
        }
        return false;
    }

    onObstacleDetected(obstacle) {
        this.obstacleAlertActive = true;
        this.obstacleAvoidanceCount++;
        this.isPaused = true; // Pause rover

        // Show alert on map
        const alert = document.getElementById('obstacleAlert');
        if (alert) {
            alert.style.display = 'flex';
            const countEl = document.getElementById('obstacleAlertCount');
            if (countEl) countEl.textContent = this.obstacleAvoidanceCount;
        }

        this.addLog('Engel tespit edildi! Alternatif rota hesaplaniyor...', true);

        // Flash the obstacle red in 3D
        if (obstacle.mesh3D) {
            obstacle.mesh3D.traverse(child => {
                if (child.isMesh) {
                    child.material = child.material.clone();
                    child.material.emissive = new THREE.Color(0xff2200);
                    child.material.emissiveIntensity = 0.6;
                }
            });

            // Reset color after 1.5s
            setTimeout(() => {
                obstacle.mesh3D.traverse(child => {
                    if (child.isMesh) {
                        child.material.emissive = new THREE.Color(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }, 1500);
        }

        // After 2 seconds, calculate avoidance path
        setTimeout(() => {
            this.avoidObstacle(obstacle);
        }, 2000);
    }

    avoidObstacle(obstacle) {
        // Create a detour: offset the next few waypoints to go around the obstacle
        const avoidRadius = obstacle.radius + 0.4;

        // Determine which side to go around
        const dx = obstacle.pos.x - this.roverPos.x;
        const dz = obstacle.pos.z - this.roverPos.z;
        // Perpendicular direction (go right by default)
        const perpX = -dz;
        const perpZ = dx;
        const perpLen = Math.sqrt(perpX * perpX + perpZ * perpZ) || 1;

        // Create 3 waypoints that arc around the obstacle
        const midX = obstacle.pos.x + (perpX / perpLen) * avoidRadius;
        const midZ = obstacle.pos.z + (perpZ / perpLen) * avoidRadius;

        const beforeX = (this.roverPos.x + midX) / 2;
        const beforeZ = (this.roverPos.z + midZ) / 2;

        // Find next path point after obstacle
        let rejoinIdx = this.pathIndex;
        for (let i = this.pathIndex; i < this.path.length; i++) {
            const d = Math.sqrt(
                Math.pow(this.path[i].x - obstacle.pos.x, 2) +
                Math.pow(this.path[i].z - obstacle.pos.z, 2)
            );
            if (d > avoidRadius * 1.5) {
                rejoinIdx = i;
                break;
            }
        }

        const afterWp = this.path[Math.min(rejoinIdx, this.path.length - 1)];
        const afterX = (midX + afterWp.x) / 2;
        const afterZ = (midZ + afterWp.z) / 2;

        // Insert detour waypoints into path
        const detour = [
            { x: beforeX, z: beforeZ },
            { x: midX, z: midZ },
            { x: afterX, z: afterZ },
        ];

        // Splice detour into path
        this.path.splice(this.pathIndex, rejoinIdx - this.pathIndex, ...detour);

        // Update 3D path line
        this.update3DPathLine();

        // Hide alert and resume
        const alert = document.getElementById('obstacleAlert');
        if (alert) alert.style.display = 'none';

        this.obstacleAlertActive = false;
        this.isPaused = false;
        this.addLog('Alternatif rota bulundu, devam ediliyor', true);
    }

    update3DPathLine() {
        if (!this.is3DReady || !this.worldToGridCoords) return;
        if (this.pathLine3D) this.scene.remove(this.pathLine3D);

        const pathPoints = [];
        for (let i = this.pathIndex; i < this.path.length; i++) {
            const wp = this.path[i];
            const gp = this.worldToGridCoords(wp.x, wp.z);
            const ze = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
            const p3d = this.getMap3DCoords(gp.gx, gp.gy, ze);
            pathPoints.push(new THREE.Vector3(p3d.x, p3d.y + 0.15, p3d.z));
        }
        if (pathPoints.length > 1) {
            const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPoints);
            const pathMat = new THREE.LineBasicMaterial({ color: 0xc678dd, linewidth: 2 });
            this.pathLine3D = new THREE.Line(pathGeom, pathMat);
            this.scene.add(this.pathLine3D);
        }
    }

    clearPathObstacles() {
        for (const obs of this.pathObstacles) {
            if (obs.mesh3D) this.scene.remove(obs.mesh3D);
        }
        this.pathObstacles = [];
    }

    updateRover() {
        if (!this.path || this.path.length === 0) return;

        if (this.pathIndex >= this.path.length) {
            if (this.missionPhase === 'TO_TARGET') {
                this.onArriveAtTarget();
            } else if (this.missionPhase === 'RETURNING') {
                this.onArriveAtBase();
            }
            return;
        }

        const prevPos = { x: this.roverPos.x, z: this.roverPos.z };
        const target = this.path[this.pathIndex];
        const dx = target.x - this.roverPos.x;
        const dz = target.z - this.roverPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Much smaller threshold for 3-unit mission (0.2 instead of 1.5)
        if (dist < 0.2) {
            this.pathIndex++;
            return;
        }

        // Check for obstacles ahead (front camera detection)
        if (this.checkObstacleAhead()) return;

        // Base speed very slow, multiplied by time accelerator
        const baseSpeed = 0.003;
        const speed = baseSpeed * this.timeMultiplier;
        this.roverPos.x += (dx / dist) * speed;
        this.roverPos.z += (dz / dist) * speed;
        this.heading = Math.atan2(dx, dz);

        // Update 3D rover position and orientation (third-person view)
        if (this.is3DReady && this.elevationMapData && this.worldToGridCoords) {
            const gridPos = this.worldToGridCoords(this.roverPos.x, this.roverPos.z);
            const zOnMesh = this.elevBilinear(this.elevationMapData, gridPos.gx, gridPos.gy);

            const rig = this.ensureRoverRig();
            rig.visible = true;

            const roverPos3D = this.getMap3DCoords(gridPos.gx, gridPos.gy, zOnMesh);
            rig.position.set(roverPos3D.x, roverPos3D.y, roverPos3D.z);

            // Calculate direction vector in 3D
            let dir = new THREE.Vector3(0, 0, 1);
            let fwdX = dx;
            let fwdZ = dz;

            const prevGrid = this.worldToGridCoords(prevPos.x, prevPos.z);
            const deltaGX = gridPos.gx - prevGrid.gx;
            const deltaGY = gridPos.gy - prevGrid.gy;

            if (Math.abs(deltaGX) > 0.01 || Math.abs(deltaGY) > 0.01) {
                const prevPos3D = this.getMap3DCoords(
                    prevGrid.gx,
                    prevGrid.gy,
                    this.elevBilinear(this.elevationMapData, prevGrid.gx, prevGrid.gy)
                );
                dir.subVectors(roverPos3D, prevPos3D);
                dir.y = 0;
                if (dir.lengthSq() > 1e-8) {
                    dir.normalize();
                } else {
                    dir.set(0, 0, 1);
                }
                fwdX = deltaGX;
                fwdZ = deltaGY;
            }

            // Rotate rover to face movement direction
            rig.rotation.y = Math.atan2(dir.x, dir.z);

            // Pitch and roll from terrain slopes
            const slopes = this.terrainSlopesAlong(this.elevationMapData, gridPos.gx, gridPos.gy, fwdX, fwdZ);
            const pitch = Math.atan(slopes.dz_fwd) * 0.92;
            const roll = Math.atan(slopes.dz_perp) * 0.78;
            rig.rotation.x = pitch * 0.5;
            rig.rotation.z = -roll * 0.4;
            rig.updateMatrixWorld(true);

            // Third-person camera: close behind the rover
            const camDist = 1.5;
            const camHeight = 0.7;
            const headingY = rig.rotation.y;

            this.targetCamPos.set(
                roverPos3D.x - Math.sin(headingY) * camDist,
                roverPos3D.y + camHeight,
                roverPos3D.z - Math.cos(headingY) * camDist
            );

            // Look slightly ahead of rover
            this.targetLookAt.set(
                roverPos3D.x + dir.x * 0.3,
                roverPos3D.y + 0.1,
                roverPos3D.z + dir.z * 0.3
            );
        }

        this.updateUI();
    }

    renderTasks() {
        const container = document.getElementById('taskList');
        container.innerHTML = '';

        this.tasks.forEach(task => {
            const div = document.createElement('div');
            div.className = 'task-item' + (task.active ? ' active' : '');
            div.innerHTML = `
                <span class="check-box" style="${task.done ? 'background: var(--accent-blue); border-color: var(--accent-blue);' : ''}">
                    ${task.done ? '<i class="fas fa-check" style="font-size: 8px; color: white;"></i>' : ''}
                </span>
                ${task.name}
            `;
            container.appendChild(div);
        });
    }

    addLog(message, highlight = false) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit' });
        const log = { message, time, highlight };
        this.logs.unshift(log);

        if (this.logs.length > 20) this.logs.pop();

        this.renderLogs();
    }

    renderLogs() {
        const container = document.getElementById('mapLogOverlay');
        if (!container) return;
        container.innerHTML = '';

        this.logs.forEach(log => {
            const div = document.createElement('div');
            div.className = 'log-entry' + (log.highlight ? ' highlight' : '');
            div.innerHTML = `
                ${log.message}
                <span class="log-time">${log.time}</span>
            `;
            container.appendChild(div);
        });
    }

    updateTimestamp() {
        const now = new Date();
        const utc = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
        document.getElementById('timestamp').textContent = utc;
    }

    updateUI() {
        const targetDist = Math.sqrt(
            Math.pow(this.targetPos.x - this.roverPos.x, 2) +
            Math.pow(this.targetPos.z - this.roverPos.z, 2)
        );

        const traveled = Math.sqrt(
            Math.pow(this.roverPos.x - this.initialRoverPos.x, 2) +
            Math.pow(this.roverPos.z - this.initialRoverPos.z, 2)
        );

        const headingDeg = Math.round((this.heading * 180 / Math.PI + 360) % 360);

        document.getElementById('traveledDist').textContent = Math.round(traveled) + ' m';
        document.getElementById('toTarget').textContent = Math.round(targetDist) + ' m';
        document.getElementById('totalDist').textContent = (targetDist / 1000).toFixed(2) + ' km';
        document.getElementById('mapDistance').textContent = (targetDist * 4.35).toFixed(2);
        document.getElementById('targetHeading').textContent = `${headingDeg}° N, ${this.targetPos.x.toFixed(0)}° E`;
        document.getElementById('compassDegree').textContent = headingDeg + '°';

        // Also update the camera panel compass
        const camCompass = document.getElementById('camCompassDeg');
        if (camCompass) camCompass.textContent = headingDeg + '°';

        if (this.isRunning) {
            const timeMin = Math.round(targetDist / this.speed / 60);
            document.getElementById('timeToTarget').textContent = timeMin + ' min';
        }

        if (this.isRunning) {
            const velEl = document.getElementById('currentVel');
            if (velEl) velEl.textContent = (0.003 * this.timeMultiplier * 33.3).toFixed(1);
        }

        // --- Telemetry gauges ---
        // Velocity: based on base speed * time multiplier
        const baseSpeed = 0.003;
        const actualSpeed = this.isRunning ? baseSpeed * this.timeMultiplier : 0;
        const velocityMs = actualSpeed * 3.33; // Scale to m/s display
        const velBar = document.getElementById('gaugeVelocity');
        const velText = document.getElementById('gaugeVelText');
        if (velBar) velBar.style.width = Math.min(velocityMs / 0.1 * 100, 100) + '%';
        if (velText) velText.textContent = velocityMs.toFixed(3) + ' m/s';

        // Throttle: time multiplier as percentage (10x = 100%)
        const throttlePct = (this.timeMultiplier / 10) * 100;
        const thrBar = document.getElementById('gaugeThrottle');
        const thrText = document.getElementById('gaugeThrottleText');
        if (thrBar) thrBar.style.width = throttlePct + '%';
        if (thrText) thrText.textContent = this.timeMultiplier + 'x';

        // Distance progress: traveled vs estimated total
        const totalEst = traveled + targetDist;
        const distPct = totalEst > 0 ? Math.min((traveled / totalEst) * 100, 100) : 0;
        const distBar = document.getElementById('gaugeDist');
        const distText = document.getElementById('gaugeDistText');
        if (distBar) distBar.style.width = distPct + '%';
        if (distText) distText.textContent = Math.round(traveled) + ' / ' + Math.round(totalEst) + ' m';

        // Slope: estimate from terrain elevation gradient
        let slopeDeg = 0;
        if (this.is3DReady && this.elevationMapData && this.worldToGridCoords) {
            const gp = this.worldToGridCoords(this.roverPos.x, this.roverPos.z);
            const delta = 0.1;
            const gpFwd = this.worldToGridCoords(
                this.roverPos.x + Math.sin(this.heading) * delta,
                this.roverPos.z + Math.cos(this.heading) * delta
            );
            const z0 = this.elevBilinear(this.elevationMapData, gp.gx, gp.gy);
            const z1 = this.elevBilinear(this.elevationMapData, gpFwd.gx, gpFwd.gy);
            slopeDeg = Math.atan2(Math.abs(z1 - z0), delta) * (180 / Math.PI);
        }
        const slopeBar = document.getElementById('gaugeSlope');
        const slopeText = document.getElementById('gaugeSlopeText');
        if (slopeBar) slopeBar.style.width = Math.min((slopeDeg / 45) * 100, 100) + '%';
        if (slopeText) slopeText.textContent = slopeDeg.toFixed(1) + '\u00B0';
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new MissionControl();
});
