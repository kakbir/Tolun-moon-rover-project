#!/usr/bin/env python3
"""
Ay Rover Simülasyonu - Flask Backend
Terrain generation, pathfinding, physics calculations
"""

from flask import Flask, jsonify, send_from_directory, request
from flask_cors import CORS
import numpy as np
from noise import pnoise2
from PIL import Image
import io
import base64
from scipy.spatial import distance
from scipy.ndimage import gaussian_filter
import urllib.request
import urllib.parse
import os
import json
import re
try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False
try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__, static_folder='web', static_url_path='')
CORS(app)

# OpenAI client for crater detection with GPT-4 Vision
if HAS_OPENAI:
    try:
        openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        GPT_VISION_ENABLED = True
        print("✅ OpenAI GPT-4 Vision enabled for crater detection")
    except:
        openai_client = None
        GPT_VISION_ENABLED = False
        print("⚠️ OpenAI API key not found - crater detection will use fallback method")
else:
    openai_client = None
    GPT_VISION_ENABLED = False
    print("⚠️ OpenAI not installed - crater detection will use fallback method")

class TerrainGenerator:
    """Perlin noise terrain generator"""

    def __init__(self, size=200, resolution=256):
        self.size = size
        self.resolution = resolution
        self.heightmap = None

    def download_real_lunar_image(self):
        """Download real NASA LROC lunar surface imagery"""
        print("🛰️ Downloading REAL LROC satellite imagery from NASA...")

        # High-resolution LROC WAC Global Mosaic
        urls = [
            # NASA Scientific Visualization Studio - 4K Moon
            "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.png",
            # LROC WAC Mosaic - High quality
            "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg",
            # NASA CGI Moon - Real texture
            "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/frames/5760x2880_16x9_30p/moon.0000.jpg"
        ]

        cache_path = "lroc_real_satellite.jpg"

        # Try cached first
        if os.path.exists(cache_path):
            try:
                print("✅ Using cached REAL LROC satellite imagery")
                img = Image.open(cache_path).convert('L')
                # High resolution for zoom
                img = img.resize((2048, 2048), Image.Resampling.LANCZOS)
                heightmap = np.array(img, dtype=np.float32)
                # Keep as 0-255 for direct use
                return heightmap
            except Exception as e:
                print(f"Cache error: {e}")
                os.remove(cache_path)

        # Download real satellite imagery
        for i, url in enumerate(urls):
            try:
                print(f"🔄 Downloading from NASA source {i+1}/{len(urls)}...")
                print(f"   URL: {url}")

                headers = {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }

                req = urllib.request.Request(url, headers=headers)

                with urllib.request.urlopen(req, timeout=30) as response:
                    with open(cache_path, 'wb') as out_file:
                        out_file.write(response.read())

                print("✅ Downloaded REAL LROC satellite imagery!")

                img = Image.open(cache_path).convert('L')
                img = img.resize((2048, 2048), Image.Resampling.LANCZOS)

                heightmap = np.array(img, dtype=np.float32)

                print(f"✅ Loaded real satellite image: {heightmap.shape}, range: {heightmap.min()}-{heightmap.max()}")
                return heightmap

            except Exception as e:
                print(f"⚠️ Source {i+1} failed: {e}")
                if os.path.exists(cache_path):
                    os.remove(cache_path)
                continue

        print("❌ All NASA sources failed")
        return self.generate_procedural()

    def generate_procedural(self):
        """Generate heightmap using Perlin noise (fallback)"""
        print("🏔️ Generating procedural terrain...")

        heightmap = np.zeros((self.resolution, self.resolution))

        scale = 0.05
        octaves = 4

        for y in range(self.resolution):
            for x in range(self.resolution):
                height = 0
                for o in range(octaves):
                    freq = 2 ** o
                    amp = 1 / freq
                    height += pnoise2(
                        x * scale * freq,
                        y * scale * freq,
                        octaves=1
                    ) * amp

                heightmap[y, x] = height * 8 + 2

        # Add craters
        heightmap = self.add_craters(heightmap)

        # Smooth
        heightmap = gaussian_filter(heightmap, sigma=1)

        print("✅ Procedural terrain generated")
        return heightmap

    def generate(self):
        """Generate terrain - try real imagery first, fallback to procedural"""
        try:
            self.heightmap = self.download_real_lunar_image()
        except:
            self.heightmap = self.generate_procedural()

        print("✅ Terrain ready")
        return self.heightmap

    def add_craters(self, heightmap):
        """Add procedural craters"""
        craters = 12

        for _ in range(craters):
            cx = np.random.randint(30, self.resolution - 30)
            cy = np.random.randint(30, self.resolution - 30)
            radius = np.random.randint(10, 30)
            depth = np.random.uniform(3, 8)

            y_grid, x_grid = np.ogrid[:self.resolution, :self.resolution]
            dist = np.sqrt((x_grid - cx)**2 + (y_grid - cy)**2)

            mask = dist < radius
            factor = np.exp(-(dist**2) / (radius**2 / 2))
            heightmap[mask] -= depth * factor[mask]

        return heightmap

    def to_image(self):
        """Convert heightmap to image"""
        if self.heightmap is None:
            self.generate()

        # Normalize 0-255
        normalized = ((self.heightmap - self.heightmap.min()) /
                     (self.heightmap.max() - self.heightmap.min()) * 255).astype(np.uint8)

        img = Image.fromarray(normalized, mode='L')
        return img

    def to_base64(self):
        """Convert to base64 for web"""
        img = self.to_image()
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        img_str = base64.b64encode(buffer.read()).decode()
        return f"data:image/png;base64,{img_str}"

    def get_height_at(self, x, y):
        """Get height at world coordinates"""
        if self.heightmap is None:
            return 0

        # Convert world to grid
        gx = int((x / self.size + 0.5) * self.resolution)
        gy = int((y / self.size + 0.5) * self.resolution)

        # Clamp
        gx = max(0, min(self.resolution - 1, gx))
        gy = max(0, min(self.resolution - 1, gy))

        return float(self.heightmap[gy, gx])


class PathFinder:
    """A* pathfinding with terrain awareness"""

    def __init__(self, terrain):
        self.terrain = terrain
        self.obstacles = []
        self.real_elevation = None
        self.elevation_bounds = None

    def set_obstacles(self, obstacles):
        """Store obstacles for collision checking"""
        self.obstacles = obstacles

    def set_real_elevation(self, elevation_grid, bounds):
        """Set real DEM elevation data from NASA tiles"""
        self.real_elevation = np.array(elevation_grid, dtype=np.float32)
        self.elevation_bounds = bounds
        print(f"✅ Real elevation data set: {self.real_elevation.shape}, range: {self.real_elevation.min():.1f}m to {self.real_elevation.max():.1f}m")

    def is_safe(self, wx, wz):
        """Check if world position is safe (not in obstacle, reasonable slope)"""

        # Use real DEM elevation if available
        if self.real_elevation is not None and self.elevation_bounds is not None:
            # Convert world coords to lon/lat
            lon = (wx / 100) * 180
            lat = (wz / 100) * 90

            # Check if within elevation grid bounds
            bounds = self.elevation_bounds
            if lon < bounds['minLon'] or lon > bounds['maxLon'] or lat < bounds['minLat'] or lat > bounds['maxLat']:
                return True  # Outside grid, assume safe

            # Convert lon/lat to elevation grid indices
            grid_height, grid_width = self.real_elevation.shape
            grid_x = int((lon - bounds['minLon']) / (bounds['maxLon'] - bounds['minLon']) * (grid_width - 1))
            grid_y = int((lat - bounds['minLat']) / (bounds['maxLat'] - bounds['minLat']) * (grid_height - 1))

            # Clamp to grid bounds
            grid_x = max(1, min(grid_width - 2, grid_x))
            grid_y = max(1, min(grid_height - 2, grid_y))

            # Check slope using real elevation data
            center = self.real_elevation[grid_y, grid_x]
            neighbors = [
                self.real_elevation[grid_y - 1, grid_x],
                self.real_elevation[grid_y + 1, grid_x],
                self.real_elevation[grid_y, grid_x - 1],
                self.real_elevation[grid_y, grid_x + 1]
            ]
            max_diff = max(abs(center - n) for n in neighbors)

            # VERY sensitive slope threshold
            if max_diff > 100:  # Any significant elevation change
                return False

            # ALSO check absolute elevation - avoid very low areas (dark craters)
            # Elevation range is -2000 to +2000
            # Dark craters map to low values (< -500)
            if center < -500:  # Very dark area = crater
                return False
        else:
            # Fallback to generated terrain
            resolution = self.terrain.resolution
            size = self.terrain.size

            gx = int((wx / size + 0.5) * resolution)
            gz = int((wz / size + 0.5) * resolution)

            # Bounds check
            if gx < 1 or gx >= resolution - 1 or gz < 1 or gz >= resolution - 1:
                return False

            # Check slope (terrain difference with neighbors)
            if self.terrain.heightmap is not None:
                center = self.terrain.heightmap[gz, gx]
                neighbors = [
                    self.terrain.heightmap[gz-1, gx],
                    self.terrain.heightmap[gz+1, gx],
                    self.terrain.heightmap[gz, gx-1],
                    self.terrain.heightmap[gz, gx+1]
                ]
                max_diff = max(abs(center - n) for n in neighbors)
                if max_diff > 5:  # Too steep
                    return False

        # Check obstacles (all types)
        for obs in self.obstacles:
            dx = wx - obs['position']['x']
            dz = wz - obs['position']['z']
            dist = np.sqrt(dx*dx + dz*dz)

            # Safety margin - 1.2x the obstacle radius (smaller margin for many small obstacles)
            safety_radius = obs['radius'] * 1.2

            if dist < safety_radius:
                return False

        return True

    def _debug_log(self, msg):
        """Write debug info to file for diagnosis"""
        with open('/tmp/moon_debug.log', 'a') as f:
            f.write(msg + '\n')
        print(msg)

    def find_path(self, start, end, grid_size=1):
        """A* pathfinding with terrain and obstacle awareness"""
        self._debug_log(f"\n{'='*60}")
        self._debug_log(f"🛤️ find_path called: {start} -> {end}")
        self._debug_log(f"   obstacles: {len(self.obstacles)}")
        self._debug_log(f"   real_elevation is None: {self.real_elevation is None}")
        self._debug_log(f"   elevation_bounds is None: {self.elevation_bounds is None}")

        # Use real LOLA DEM elevation data if available
        if self.real_elevation is not None and self.elevation_bounds is not None:
            self._debug_log("   >>> USING _find_path_elevation (LOLA DEM)")
            return self._find_path_elevation(start, end)
        else:
            self._debug_log("   >>> USING old find_path (procedural terrain)")

        size = self.terrain.size
        resolution = self.terrain.resolution // grid_size

        # Convert to grid
        def world_to_grid(x, z):
            gx = int((x / size + 0.5) * resolution)
            gz = int((z / size + 0.5) * resolution)
            return (max(0, min(resolution-1, gx)), max(0, min(resolution-1, gz)))

        def grid_to_world(gx, gz):
            x = (gx / resolution - 0.5) * size
            z = (gz / resolution - 0.5) * size
            return (x, z)

        start_grid = world_to_grid(start['x'], start['z'])
        end_grid = world_to_grid(end['x'], end['z'])

        # A* algorithm
        from heapq import heappush, heappop

        open_set = []
        heappush(open_set, (0, start_grid))

        came_from = {}
        g_score = {start_grid: 0}
        f_score = {start_grid: self.heuristic(start_grid, end_grid)}

        while open_set:
            current = heappop(open_set)[1]

            if current == end_grid:
                # Reconstruct path
                path = []
                node = current
                while node in came_from:
                    wx, wz = grid_to_world(node[0], node[1])
                    wy = self.terrain.get_height_at(wx, wz) + 2
                    path.insert(0, {'x': wx, 'y': wy, 'z': wz})
                    node = came_from[node]

                # Add start and end
                wx, wz = grid_to_world(start_grid[0], start_grid[1])
                path.insert(0, {'x': start['x'], 'y': self.terrain.get_height_at(start['x'], start['z']) + 2, 'z': start['z']})
                path.append({'x': end['x'], 'y': self.terrain.get_height_at(end['x'], end['z']) + 2, 'z': end['z']})

                print(f"✅ Path found: {len(path)} waypoints")
                return path

            # Check neighbors
            for dx, dz in [(-1,0), (1,0), (0,-1), (0,1), (-1,-1), (-1,1), (1,-1), (1,1)]:
                neighbor = (current[0] + dx, current[1] + dz)

                if neighbor[0] < 0 or neighbor[0] >= resolution or neighbor[1] < 0 or neighbor[1] >= resolution:
                    continue

                # Check if safe
                wx, wz = grid_to_world(neighbor[0], neighbor[1])
                if not self.is_safe(wx, wz):
                    continue

                # Cost (diagonal costs more)
                move_cost = 1.414 if dx != 0 and dz != 0 else 1.0
                tentative_g = g_score[current] + move_cost

                if neighbor not in g_score or tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    f_score[neighbor] = tentative_g + self.heuristic(neighbor, end_grid)
                    heappush(open_set, (f_score[neighbor], neighbor))

        # No path found, return straight line as fallback
        print("⚠️ No safe path found, using fallback")
        return self.fallback_path(start, end)

    def _find_path_elevation(self, start, end):
        """A* pathfinding using real NASA LOLA DEM elevation data with terrain cost map"""
        from heapq import heappush, heappop
        from scipy.ndimage import uniform_filter, sobel

        bounds = self.elevation_bounds
        elev = self.real_elevation
        grid_h, grid_w = elev.shape

        self._debug_log(f"   _find_path_elevation ENTERED")
        self._debug_log(f"   Grid: {grid_w}x{grid_h}")
        self._debug_log(f"   Elevation range: {elev.min():.0f}m to {elev.max():.0f}m, std={elev.std():.0f}m")

        # ---- Pre-compute terrain cost map ----
        # 1) Depression detection: cells below local average = crater interior
        kernel = max(11, grid_w // 10)  # ~10% of grid width
        if kernel % 2 == 0:
            kernel += 1
        local_avg = uniform_filter(elev.astype(np.float64), size=kernel)
        depression = np.maximum(0, local_avg - elev)  # Positive where below average

        # 2) Gradient magnitude: steep terrain / crater rims
        grad_x = sobel(elev.astype(np.float64), axis=1)
        grad_y = sobel(elev.astype(np.float64), axis=0)
        gradient = np.sqrt(grad_x ** 2 + grad_y ** 2)

        # 3) Below-median penalty: cells lower than median = lowlands/crater floors
        median_elev = float(np.median(elev))
        below_median = np.maximum(0, median_elev - elev)
        bm_norm = below_median / max(float(below_median.max()), 1)  # 0..1

        # 4) Build cost multiplier grid - AGGRESSIVE penalties
        dep_norm = depression / max(float(depression.max()), 1)  # 0..1
        grad_norm = gradient / max(float(gradient.max()), 1)     # 0..1

        cost_map = np.ones_like(elev, dtype=np.float64)
        cost_map += dep_norm * 100.0          # Depression: up to 101x cost
        cost_map += grad_norm * 50.0          # Gradient/rims: up to 51x cost
        cost_map += bm_norm ** 1.5 * 30.0    # Below-median lowlands: up to 31x cost

        self._debug_log(f"   Depression max: {depression.max():.0f}m, kernel={kernel}")
        self._debug_log(f"   Gradient max: {gradient.max():.0f}")
        self._debug_log(f"   Median elevation: {median_elev:.0f}m, below-median max: {below_median.max():.0f}m")
        self._debug_log(f"   Cost map range: {cost_map.min():.1f} to {cost_map.max():.1f}")

        def world_to_grid(x, z):
            lon = (x / 100) * 180
            lat = (z / 100) * 90
            gx = (lon - bounds['minLon']) / (bounds['maxLon'] - bounds['minLon']) * (grid_w - 1)
            gy = (lat - bounds['minLat']) / (bounds['maxLat'] - bounds['minLat']) * (grid_h - 1)
            return (max(0, min(grid_w - 1, int(round(gx)))), max(0, min(grid_h - 1, int(round(gy)))))

        def grid_to_world(gx, gy):
            lon = bounds['minLon'] + (gx / (grid_w - 1)) * (bounds['maxLon'] - bounds['minLon'])
            lat = bounds['minLat'] + (gy / (grid_h - 1)) * (bounds['maxLat'] - bounds['minLat'])
            x = (lon / 180) * 100
            z = (lat / 90) * 100
            return (x, z)

        start_grid = world_to_grid(start['x'], start['z'])
        end_grid = world_to_grid(end['x'], end['z'])

        self._debug_log(f"   Start grid: {start_grid} (elev={float(elev[start_grid[1], start_grid[0]]):.0f}m, cost={cost_map[start_grid[1], start_grid[0]]:.1f})")
        self._debug_log(f"   End grid:   {end_grid} (elev={float(elev[end_grid[1], end_grid[0]]):.0f}m, cost={cost_map[end_grid[1], end_grid[0]]:.1f})")
        self._debug_log(f"   Obstacles SKIPPED (cost map handles terrain avoidance), count was: {len(self.obstacles)}")

        # Log cost along straight line to see if craters are detected
        self._debug_log(f"   --- Cost along straight line ---")
        steps = 20
        total_straight_cost = 0
        for i in range(steps + 1):
            t = i / steps
            gx = int(start_grid[0] + (end_grid[0] - start_grid[0]) * t)
            gy = int(start_grid[1] + (end_grid[1] - start_grid[1]) * t)
            gx = max(0, min(grid_w - 1, gx))
            gy = max(0, min(grid_h - 1, gy))
            e = float(elev[gy, gx])
            c = float(cost_map[gy, gx])
            d = float(depression[gy, gx])
            g = float(gradient[gy, gx])
            bm = float(below_median[gy, gx])
            total_straight_cost += c
            self._debug_log(f"   t={t:.2f} ({gx},{gy}) elev={e:.0f}m cost={c:.1f} dep={d:.0f} grad={g:.0f} bm={bm:.0f}")
        self._debug_log(f"   Total straight-line cost: {total_straight_cost:.1f}")

        open_set = []
        heappush(open_set, (0, start_grid))
        came_from = {}
        g_score = {start_grid: 0}

        visited = set()
        max_iter = grid_w * grid_h * 4
        iteration = 0

        while open_set and iteration < max_iter:
            iteration += 1
            _, current = heappop(open_set)

            if current in visited:
                continue
            visited.add(current)

            if current == end_grid:
                # Reconstruct path
                path = []
                node = current
                while node in came_from:
                    wx, wz = grid_to_world(node[0], node[1])
                    path.insert(0, {'x': wx, 'y': float(elev[node[1], node[0]]), 'z': wz})
                    node = came_from[node]

                path.insert(0, {'x': start['x'], 'y': 0, 'z': start['z']})
                path.append({'x': end['x'], 'y': 0, 'z': end['z']})

                # Log deviation
                max_dev = 0
                dx_total = end['x'] - start['x']
                dz_total = end['z'] - start['z']
                length = np.sqrt(dx_total ** 2 + dz_total ** 2)
                if length > 0:
                    for p in path:
                        t = ((p['x'] - start['x']) * dx_total + (p['z'] - start['z']) * dz_total) / (length ** 2)
                        closest_x = start['x'] + t * dx_total
                        closest_z = start['z'] + t * dz_total
                        dev = np.sqrt((p['x'] - closest_x) ** 2 + (p['z'] - closest_z) ** 2)
                        max_dev = max(max_dev, dev)

                self._debug_log(f"   ✅ PATH FOUND: {len(path)} waypoints, {iteration} iters, {len(visited)} visited")
                self._debug_log(f"   Max deviation: {max_dev:.3f}")
                self._debug_log(f"   Path: {[(round(p['x'],2), round(p['z'],2)) for p in path[::max(1,len(path)//10)]]}")
                return path

            for dx, dz in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]:
                nx, nz = current[0] + dx, current[1] + dz

                if nx < 0 or nx >= grid_w or nz < 0 or nz >= grid_h:
                    continue

                neighbor = (nx, nz)
                if neighbor in visited:
                    continue

                # NOTE: No obstacle collision check here — the LOLA DEM cost map
                # (depression + gradient + below-median penalties) already handles
                # terrain avoidance far more accurately than brightness-detected
                # obstacles, which have oversized radii that block the entire grid.

                # Movement cost = base distance * terrain cost multiplier
                base_cost = 1.414 if dx != 0 and dz != 0 else 1.0
                terrain_cost = float(cost_map[nz, nx])
                move_cost = base_cost * terrain_cost

                tentative_g = g_score[current] + move_cost

                if neighbor not in g_score or tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    f = tentative_g + self.heuristic(neighbor, end_grid)
                    heappush(open_set, (f, neighbor))

        self._debug_log(f"   ⚠️ NO PATH after {iteration} iters, {len(visited)} visited")
        return self.fallback_path(start, end)

    def heuristic(self, a, b):
        """Euclidean distance heuristic"""
        return np.sqrt((a[0] - b[0])**2 + (a[1] - b[1])**2)

    def fallback_path(self, start, end):
        """Straight line path as fallback"""
        path = []
        steps = 30
        for i in range(steps + 1):
            t = i / steps
            x = start['x'] + (end['x'] - start['x']) * t
            z = start['z'] + (end['z'] - start['z']) * t
            y = self.terrain.get_height_at(x, z) + 2
            path.append({'x': x, 'y': y, 'z': z})
        return path


# Global instances
terrain = TerrainGenerator(size=200, resolution=256)
terrain.generate()
pathfinder = PathFinder(terrain)
current_obstacles = []

# Routes
@app.route('/')
def index():
    """Serve main page"""
    return send_from_directory('web', 'index.html')

@app.route('/terrain3d.html')
def terrain3d():
    """Serve 3D terrain page"""
    return send_from_directory('web', 'terrain3d.html')

@app.route('/api/terrain/generate', methods=['GET'])
def generate_terrain():
    """Generate new terrain"""
    try:
        heightmap = terrain.generate()

        # Return heightmap data
        return jsonify({
            'success': True,
            'heightmap': terrain.to_base64(),
            'resolution': terrain.resolution,
            'size': terrain.size,
            'stats': {
                'min': float(heightmap.min()),
                'max': float(heightmap.max()),
                'mean': float(heightmap.mean())
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/terrain/height', methods=['POST'])
def get_height():
    """Get height at position"""
    try:
        data = request.json
        x = data.get('x', 0)
        y = data.get('y', 0)

        height = terrain.get_height_at(x, y)

        return jsonify({
            'success': True,
            'height': height
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/pathfinding/find', methods=['POST'])
def find_path():
    """Find path from start to end using real DEM elevation data"""
    try:
        data = request.json
        start = data.get('start')
        end = data.get('end')
        elevation_grid = data.get('elevationGrid')
        grid_bounds = data.get('gridBounds')

        with open('/tmp/moon_debug.log', 'a') as f:
            f.write(f"\n/api/pathfinding/find called\n")
            f.write(f"  start={start}, end={end}\n")
            f.write(f"  elevation_grid type={type(elevation_grid).__name__}, truthy={bool(elevation_grid)}\n")
            f.write(f"  grid_bounds={grid_bounds}\n")
            if elevation_grid:
                f.write(f"  grid size: {len(elevation_grid)}x{len(elevation_grid[0]) if elevation_grid else 0}\n")
                # Check elevation variance
                flat = [v for row in elevation_grid for v in row]
                f.write(f"  grid min={min(flat):.1f}, max={max(flat):.1f}, range={max(flat)-min(flat):.1f}\n")

        if not start or not end:
            return jsonify({'success': False, 'error': 'Missing start or end'}), 400

        # If we have real elevation data, use it
        if elevation_grid and grid_bounds:
            print(f"🗺️ Using real NASA DEM elevation data ({len(elevation_grid)}x{len(elevation_grid[0])} grid)")
            pathfinder.set_real_elevation(elevation_grid, grid_bounds)
        else:
            with open('/tmp/moon_debug.log', 'a') as f:
                f.write(f"  ❌ NO elevation data passed! Using old terrain.\n")

        path = pathfinder.find_path(start, end)

        with open('/tmp/moon_debug.log', 'a') as f:
            f.write(f"  Result: {len(path)} waypoints\n")

        return jsonify({
            'success': True,
            'path': path
        })
    except Exception as e:
        import traceback
        with open('/tmp/moon_debug.log', 'a') as f:
            f.write(f"  ❌ EXCEPTION: {str(e)}\n")
            f.write(traceback.format_exc() + '\n')
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/obstacles/generate', methods=['GET'])
def generate_obstacles():
    """Generate random obstacles"""
    global current_obstacles
    try:
        obstacles = []
        count = 20

        for _ in range(count):
            x = np.random.uniform(-80, 80)
            z = np.random.uniform(-80, 80)
            y = terrain.get_height_at(x, z)

            obstacles.append({
                'type': 'rock' if np.random.random() > 0.3 else 'crater',
                'position': {'x': float(x), 'y': float(y), 'z': float(z)},
                'radius': float(np.random.uniform(2, 8)),
                'height': float(np.random.uniform(2, 6))
            })

        current_obstacles = obstacles
        pathfinder.set_obstacles(obstacles)
        print(f"✅ Generated {len(obstacles)} obstacles for pathfinding")

        return jsonify({
            'success': True,
            'obstacles': obstacles
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/obstacles/set', methods=['POST'])
def set_obstacles():
    """Set obstacles detected from satellite imagery"""
    global current_obstacles
    try:
        data = request.json
        obstacles = data.get('obstacles', [])

        current_obstacles = obstacles
        pathfinder.set_obstacles(obstacles)
        print(f"✅ Received {len(obstacles)} detected obstacles from imagery")

        return jsonify({
            'success': True,
            'count': len(obstacles)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/craters/detect-ai', methods=['POST'])
def detect_craters_ai():
    """Use GPT-4 Vision to detect craters from satellite imagery"""
    try:
        if not GPT_VISION_ENABLED:
            return jsonify({
                'success': False,
                'error': 'OpenAI API key not configured',
                'craters': []
            })

        data = request.json
        image_base64 = data.get('image')  # Base64 encoded image
        map_bounds = data.get('bounds', {})  # {minLon, maxLon, minLat, maxLat}

        if not image_base64:
            return jsonify({'success': False, 'error': 'No image provided'})

        print(f"🤖 Analyzing satellite imagery with GPT-4 Vision for crater detection...")

        # Prepare the prompt for GPT-4 Vision
        prompt = """You are analyzing a NASA LROC lunar satellite image to detect impact craters.

IMPORTANT: Look carefully at this lunar surface image and identify ALL visible impact craters, especially:
- Large, obvious craters (dark circular depressions with raised rims)
- Medium-sized craters
- Small but distinct craters

For EACH crater you detect, provide:
1. Approximate center position as percentage of image width/height (0-100%)
2. Approximate radius as percentage of image width (1-100%)

Return your analysis as a JSON array in this EXACT format:
[
  {"x_percent": 45.0, "y_percent": 30.0, "radius_percent": 8.5, "confidence": "high"},
  {"x_percent": 72.0, "y_percent": 65.0, "radius_percent": 4.2, "confidence": "medium"}
]

Be thorough - it's better to detect more craters than to miss obvious ones. Focus on:
- Dark circular or oval depressions
- Areas with shadows indicating depth
- Raised crater rims
- Central peaks in larger craters

ONLY return the JSON array, nothing else."""

        # Call GPT-4 Vision
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens=2000,
            temperature=0.3
        )

        result_text = response.choices[0].message.content.strip()
        print(f"🤖 GPT-4 Vision response: {result_text[:200]}...")

        # Extract JSON from response (handle markdown code blocks)
        json_match = re.search(r'\[[\s\S]*\]', result_text)
        if json_match:
            craters_data = json.loads(json_match.group(0))
        else:
            craters_data = []

        print(f"✅ GPT-4 Vision detected {len(craters_data)} craters")

        # Convert percentages to actual coordinates
        min_lon = map_bounds.get('minLon', 0)
        max_lon = map_bounds.get('maxLon', 1)
        min_lat = map_bounds.get('minLat', 0)
        max_lat = map_bounds.get('maxLat', 1)

        craters = []
        for crater in craters_data:
            x_pct = crater.get('x_percent', 50) / 100.0
            y_pct = crater.get('y_percent', 50) / 100.0
            radius_pct = crater.get('radius_percent', 5) / 100.0

            # Convert to lon/lat
            lon = min_lon + (max_lon - min_lon) * x_pct
            lat = max_lat - (max_lat - min_lat) * y_pct  # Y is inverted in images

            # Estimate radius in degrees
            radius_deg = (max_lon - min_lon) * radius_pct

            craters.append({
                'lon': lon,
                'lat': lat,
                'radius': radius_deg,
                'confidence': crater.get('confidence', 'medium')
            })

        return jsonify({
            'success': True,
            'craters': craters,
            'count': len(craters)
        })

    except Exception as e:
        print(f"❌ GPT-4 Vision error: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e),
            'craters': []
        })

@app.route('/api/craters/detect-opencv', methods=['POST'])
def detect_craters_opencv():
    """Use OpenCV Hough Circle Transform to detect craters"""
    if not HAS_CV2:
        return jsonify({'success': False, 'error': 'OpenCV not available', 'craters': []})
    try:
        data = request.json
        image_base64 = data.get('image')
        map_bounds = data.get('bounds', {})

        if not image_base64:
            return jsonify({'success': False, 'error': 'No image provided'})

        print(f"🔬 Analyzing satellite imagery with OpenCV for crater detection...")

        # Decode base64 image
        image_data = base64.b64decode(image_base64)
        nparr = np.frombuffer(image_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)

        if img is None:
            return jsonify({'success': False, 'error': 'Failed to decode image'})

        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(img, (9, 9), 2)

        # Detect circles using Hough Circle Transform
        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1.2,                    # Inverse ratio of accumulator resolution
            minDist=20,                # Minimum distance between circle centers
            param1=50,                 # Canny edge detection threshold
            param2=30,                 # Accumulator threshold (lower = more circles)
            minRadius=5,               # Minimum circle radius in pixels
            maxRadius=100              # Maximum circle radius in pixels
        )

        craters = []

        if circles is not None:
            circles = np.round(circles[0, :]).astype("int")
            print(f"✅ OpenCV detected {len(circles)} potential craters")

            # Get image dimensions
            height, width = img.shape
            min_lon = map_bounds.get('minLon', 0)
            max_lon = map_bounds.get('maxLon', 1)
            min_lat = map_bounds.get('minLat', 0)
            max_lat = map_bounds.get('maxLat', 1)

            # Filter circles by checking if they're actually dark (craters)
            for (x, y, r) in circles:
                # Sample brightness at center
                center_brightness = int(img[y, x])

                # Sample average brightness in a ring around the circle
                ring_brightness = 0
                ring_samples = 0
                for angle in range(0, 360, 30):
                    rad = np.radians(angle)
                    sample_x = int(x + r * 0.7 * np.cos(rad))
                    sample_y = int(y + r * 0.7 * np.sin(rad))
                    if 0 <= sample_x < width and 0 <= sample_y < height:
                        ring_brightness += int(img[sample_y, sample_x])
                        ring_samples += 1

                if ring_samples > 0:
                    avg_ring_brightness = ring_brightness / ring_samples

                    # Crater = dark center, lighter rim
                    # Center should be at least 15 units darker than rim
                    if center_brightness < avg_ring_brightness - 15:
                        # Convert pixel coordinates to lon/lat
                        x_pct = x / width
                        y_pct = y / height

                        lon = min_lon + (max_lon - min_lon) * x_pct
                        lat = max_lat - (max_lat - min_lat) * y_pct

                        # Convert radius from pixels to degrees
                        radius_deg = (max_lon - min_lon) * (r / width)

                        # Calculate confidence based on brightness difference
                        brightness_diff = avg_ring_brightness - center_brightness
                        confidence = 'high' if brightness_diff > 30 else 'medium'

                        craters.append({
                            'lon': lon,
                            'lat': lat,
                            'radius': radius_deg,
                            'confidence': confidence,
                            'brightness_diff': brightness_diff
                        })

            print(f"✅ After filtering: {len(craters)} confirmed craters")
        else:
            print(f"⚠️ No circles detected by OpenCV")

        return jsonify({
            'success': True,
            'craters': craters,
            'count': len(craters)
        })

    except Exception as e:
        print(f"❌ OpenCV error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e),
            'craters': []
        })

# ============================================================
# NASA MOON TREK LOLA DEM - Real Elevation Data
# ============================================================

@app.route('/api/elevation/grid', methods=['POST'])
def get_elevation_grid_nasa():
    """Fetch real elevation grid from NASA Moon Trek LOLA DEM API"""
    try:
        data = request.json
        min_lon = data['minLon']
        max_lon = data['maxLon']
        min_lat = data['minLat']
        max_lat = data['maxLat']
        grid_size = data.get('gridSize', 40)

        print(f"🛰️ Fetching LOLA DEM: lon=[{min_lon:.3f},{max_lon:.3f}], lat=[{min_lat:.3f},{max_lat:.3f}], grid={grid_size}x{grid_size}")

        def fetch_row(row_idx):
            """Fetch one row of elevation data from Moon Trek multiDEM API"""
            lat = min_lat + (max_lat - min_lat) * row_idx / (grid_size - 1)
            path_json = json.dumps([[min_lon, lat], [max_lon, lat]])
            params = urllib.parse.urlencode({
                'body': 'moon',
                'path': path_json,
                'numberOfPoints': grid_size,
                'radiusInMeters': 1737400,
                'offset': 0
            })
            url = f"https://trek.nasa.gov/moon/TrekServices/ws/elevationProfile/multiDEM?{params}"

            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'MoonRoverSim/1.0'
                })
                with urllib.request.urlopen(req, timeout=15) as resp:
                    result = json.loads(resp.read())

                # Prefer LRO LOLA DEM
                for path_data in result.get('paths', []):
                    if 'LOLA' in path_data.get('DEM', ''):
                        elevations = [p['elevation'] for p in path_data['line']]
                        return [e if e > -32000 else None for e in elevations]

                # Fallback to first available DEM
                if result.get('paths') and result['paths'][0].get('line'):
                    elevations = [p['elevation'] for p in result['paths'][0]['line']]
                    return [e if e > -32000 else None for e in elevations]

                return None
            except Exception as e:
                print(f"  ⚠️ Row {row_idx} failed: {e}")
                return None

        # Fetch all rows in parallel (8 concurrent threads)
        with ThreadPoolExecutor(max_workers=8) as executor:
            rows = list(executor.map(fetch_row, range(grid_size)))

        # Build grid and handle failures with interpolation
        grid = []
        success_count = 0
        for row in rows:
            if row and len(row) >= grid_size:
                grid.append(row[:grid_size])
                success_count += 1
            elif row:
                padded = row + [row[-1]] * (grid_size - len(row))
                grid.append(padded[:grid_size])
                success_count += 1
            else:
                grid.append(None)

        # Interpolate failed rows from neighbors
        for i in range(len(grid)):
            if grid[i] is None:
                prev_valid = next((j for j in range(i - 1, -1, -1) if grid[j] is not None), None)
                next_valid = next((j for j in range(i + 1, len(grid)) if grid[j] is not None), None)

                if prev_valid is not None and next_valid is not None:
                    t = (i - prev_valid) / (next_valid - prev_valid)
                    grid[i] = [
                        (grid[prev_valid][k] or 0) * (1 - t) + (grid[next_valid][k] or 0) * t
                        for k in range(grid_size)
                    ]
                elif prev_valid is not None:
                    grid[i] = list(grid[prev_valid])
                elif next_valid is not None:
                    grid[i] = list(grid[next_valid])
                else:
                    grid[i] = [0.0] * grid_size

        # Replace any remaining None values in cells
        for i in range(len(grid)):
            for j in range(len(grid[i])):
                if grid[i][j] is None:
                    grid[i][j] = 0.0

        # Upsample to finer grid (4x) for better pathfinding resolution
        coarse = np.array(grid, dtype=np.float64)
        from scipy.ndimage import zoom as scipy_zoom
        upscale = 4
        fine = scipy_zoom(coarse, upscale, order=1)  # bilinear interpolation
        fine_grid = fine.tolist()
        fine_size = grid_size * upscale

        # Stats
        all_elev = [e for row in fine_grid for e in row]
        min_elev = min(all_elev) if all_elev else 0
        max_elev = max(all_elev) if all_elev else 0

        print(f"✅ LOLA DEM: {success_count}/{grid_size} rows fetched, upsampled to {fine_size}x{fine_size}")
        print(f"   Elevation range: {min_elev:.0f}m to {max_elev:.0f}m")

        return jsonify({
            'success': success_count > grid_size // 3,
            'grid': fine_grid,
            'gridSize': fine_size,
            'sampledRows': success_count,
            'minElevation': min_elev,
            'maxElevation': max_elev
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


# ============================================================
# ELEVATION MAP PROCESSING - LROC WAC Topography
# ============================================================

elevation_cache = None

def process_elevation_map_image(grid_size=200):
    """Process LROC WAC Topography elevation map to extract real elevation data.
    Reads the color-coded elevation image, samples the color bar,
    and converts each pixel to an elevation value."""
    global elevation_cache

    if elevation_cache is not None:
        return elevation_cache

    image_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'elevation_map.jpg')
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Elevation map not found: {image_path}")

    print("🗺️ Processing LROC WAC Topography elevation map...")

    img = cv2.imread(image_path)
    if img is None:
        raise ValueError("Cannot read elevation map image")

    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]
    print(f"  Image size: {w}x{h}")

    # --- Step 1: Find the moon disk ---
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 20, 255, cv2.THRESH_BINARY)

    # Morphological cleanup
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    largest = max(contours, key=cv2.contourArea)
    (cx, cy), radius = cv2.minEnclosingCircle(largest)
    cx, cy, radius = float(cx), float(cy), float(radius)
    print(f"  Moon disk: center=({cx:.0f}, {cy:.0f}), radius={radius:.0f}")

    # --- Step 2: Sample the color bar ---
    # Find the horizontal extent of the colored bar strip at image mid-height
    img_hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    bar_x_start = None
    bar_x_end = None
    mid_y = int(h * 0.5)

    for test_x in range(int(cx + radius + 20), w - 5):
        sat = float(img_hsv[mid_y, test_x, 1])
        if sat > 80:
            if bar_x_start is None:
                bar_x_start = test_x
            bar_x_end = test_x

    bar_x = ((bar_x_start or int(w * 0.83)) + (bar_x_end or int(w * 0.86))) // 2

    # Find vertical extent: scan at bar_x for colored or white pixels
    bar_top = None
    bar_bottom = None
    for y in range(int(h * 0.05), int(h * 0.95)):
        pixel_rgb = img_rgb[y, min(bar_x, w - 1)]
        pixel_hsv = img_hsv[y, min(bar_x, w - 1)]
        sat = float(pixel_hsv[1])
        brightness = float(pixel_rgb.mean())
        # Bar has high saturation (colored) OR high brightness (white top)
        if sat > 20 or brightness > 200:
            if bar_top is None:
                bar_top = y
            bar_bottom = y

    if bar_top is None:
        bar_top = int(h * 0.28)
    if bar_bottom is None:
        bar_bottom = int(h * 0.85)

    print(f"  Color bar: x={bar_x}, y={bar_top}-{bar_bottom}")

    # Sample colors along the bar (top=highest, bottom=lowest)
    num_samples = 512
    bar_colors = np.zeros((num_samples, 3), dtype=np.float32)
    bar_elevations = np.linspace(10760, -9150, num_samples)

    for i in range(num_samples):
        y = int(bar_top + i * (bar_bottom - bar_top) / (num_samples - 1))
        y_s = max(0, y - 1)
        y_e = min(h, y + 2)
        x_s = max(0, bar_x - 2)
        x_e = min(w, bar_x + 3)
        region = img_rgb[y_s:y_e, x_s:x_e]
        if region.size > 0:
            bar_colors[i] = region.mean(axis=(0, 1))

    # --- Step 3: Convert moon disk pixels to elevation ---
    elevation_grid = np.full((grid_size, grid_size), np.nan, dtype=np.float32)

    print(f"  Processing {grid_size}x{grid_size} grid...")
    for gy in range(grid_size):
        for gx in range(grid_size):
            norm_x = (gx / (grid_size - 1)) * 2 - 1
            norm_y = (gy / (grid_size - 1)) * 2 - 1

            dist = np.sqrt(norm_x ** 2 + norm_y ** 2)
            if dist > 0.95:
                continue

            ix = int(cx + norm_x * radius * 0.95)
            iy = int(cy + norm_y * radius * 0.95)

            if ix < 0 or ix >= w or iy < 0 or iy >= h:
                continue

            pixel = img_rgb[iy, ix].astype(np.float32)
            if pixel.mean() < 12:
                continue

            # Find closest matching color in the bar
            diffs = bar_colors - pixel
            distances = np.sum(diffs ** 2, axis=1)
            best_idx = int(np.argmin(distances))
            elevation_grid[gy, gx] = bar_elevations[best_idx]

    # Fill NaN with average
    valid = ~np.isnan(elevation_grid)
    if valid.any():
        avg = float(np.nanmean(elevation_grid))
        elevation_grid[~valid] = avg
    else:
        elevation_grid[:] = 0

    # Light smoothing
    elevation_grid = gaussian_filter(elevation_grid, sigma=1.5)

    min_elev = float(np.nanmin(elevation_grid[valid])) if valid.any() else -9150
    max_elev = float(np.nanmax(elevation_grid[valid])) if valid.any() else 10760

    print(f"  ✅ Elevation range: {min_elev:.0f}m to {max_elev:.0f}m")

    # Round to integers for efficient JSON transfer
    grid_int = np.round(elevation_grid).astype(int).tolist()

    elevation_cache = {
        'grid': grid_int,
        'grid_size': grid_size,
        'min_elevation': min_elev,
        'max_elevation': max_elev
    }

    return elevation_cache


@app.route('/api/terrain/elevation-map', methods=['GET'])
def get_elevation_map():
    """Serve processed elevation data from the LROC topography image"""
    try:
        data = process_elevation_map_image()
        return jsonify({
            'success': True,
            **data
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/pathfinding/terrain', methods=['POST'])
def find_path_on_terrain():
    """A* pathfinding on the elevation grid with slope awareness"""
    try:
        data = request.json
        start_gx = data['startX']
        start_gy = data['startY']
        end_gx = data['endX']
        end_gy = data['endY']
        max_slope_deg = data.get('maxSlope', 25)

        elev_data = process_elevation_map_image()
        grid = elev_data['grid']
        grid_size = elev_data['grid_size']

        print(f"🛤️ Terrain pathfinding: ({start_gx},{start_gy}) → ({end_gx},{end_gy})")

        from heapq import heappush, heappop

        start = (int(start_gx), int(start_gy))
        end = (int(end_gx), int(end_gy))

        open_set = []
        heappush(open_set, (0, start))
        came_from = {}
        g_score = {start: 0}

        # Heuristic: Euclidean distance
        def h(a, b):
            return np.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

        # Cell size in meters (Moon diameter / grid cells)
        # Moon radius = 1737.4 km, diameter = 3474.8 km
        cell_size_m = 3_474_800 / grid_size

        visited = set()
        max_iterations = grid_size * grid_size * 2

        iteration = 0
        while open_set and iteration < max_iterations:
            iteration += 1
            _, current = heappop(open_set)

            if current in visited:
                continue
            visited.add(current)

            if current == end:
                # Reconstruct path
                path = []
                node = current
                while node in came_from:
                    elev = grid[node[1]][node[0]]
                    path.insert(0, {'gx': node[0], 'gy': node[1], 'elevation': elev})
                    node = came_from[node]
                elev = grid[start[1]][start[0]]
                path.insert(0, {'gx': start[0], 'gy': start[1], 'elevation': elev})

                # Simplify path - keep direction changes + regular samples
                if len(path) > 3:
                    simplified = [path[0]]
                    # Keep a point every N steps, plus direction changes
                    sample_interval = max(3, len(path) // 50)
                    for i in range(1, len(path) - 1):
                        prev_dx = path[i]['gx'] - path[i - 1]['gx']
                        prev_dy = path[i]['gy'] - path[i - 1]['gy']
                        next_dx = path[i + 1]['gx'] - path[i]['gx']
                        next_dy = path[i + 1]['gy'] - path[i]['gy']
                        is_turn = prev_dx != next_dx or prev_dy != next_dy
                        is_sample = (i % sample_interval == 0)
                        if is_turn or is_sample:
                            simplified.append(path[i])
                    simplified.append(path[-1])
                    path = simplified

                print(f"  ✅ Path found: {len(path)} waypoints, {iteration} iterations")
                return jsonify({
                    'success': True,
                    'path': path,
                    'iterations': iteration
                })

            # 8-connected neighbors
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (-1, 1), (1, -1), (1, 1)]:
                nx, ny = current[0] + dx, current[1] + dy

                if nx < 0 or nx >= grid_size or ny < 0 or ny >= grid_size:
                    continue

                neighbor = (nx, ny)
                if neighbor in visited:
                    continue

                # Calculate slope
                elev_current = grid[current[1]][current[0]]
                elev_neighbor = grid[ny][nx]
                elev_diff = abs(elev_neighbor - elev_current)
                horiz_dist = np.sqrt(dx ** 2 + dy ** 2) * cell_size_m
                slope_rad = np.arctan2(elev_diff, horiz_dist)
                slope_deg = np.degrees(slope_rad)

                if slope_deg > max_slope_deg:
                    continue

                # Movement cost: distance + slope penalty
                move_cost = np.sqrt(dx ** 2 + dy ** 2)
                slope_penalty = (slope_deg / max_slope_deg) ** 2 * 3
                total_cost = move_cost + slope_penalty

                tentative_g = g_score[current] + total_cost

                if neighbor not in g_score or tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    f = tentative_g + h(neighbor, end)
                    heappush(open_set, (f, neighbor))

        print(f"  ⚠️ No path found after {iteration} iterations")
        return jsonify({
            'success': False,
            'error': 'No safe path found - terrain too steep',
            'iterations': iteration
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    print("🌙 Ay Rover Simülasyonu - Flask Server")
    print("=====================================")
    print("Starting server on http://localhost:5001")
    print("")

    # Generate initial terrain
    terrain.generate()

    # Pre-process elevation map
    try:
        process_elevation_map_image()
        print("✅ Elevation map processed and cached")
    except Exception as e:
        print(f"⚠️ Elevation map not available: {e}")

    port = int(os.environ.get('PORT', 5001))
    app.run(debug=False, host='0.0.0.0', port=port)
