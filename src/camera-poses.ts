import { Vec3, EventHandle } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { Events } from './events';
import { Splat } from './splat';
import { ElementType } from './element';

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3
};

const registerCameraPosesEvents = (events: Events) => {

    // simplify keys toggle (default OFF)
    let simplifyKeys = false;
    events.function('camera.simplify.get', () => simplifyKeys);
    events.on('camera.simplify.set', (v: boolean) => { simplifyKeys = !!v; });

    // 提取旋转矩阵第三列（相机 Z 轴在世界坐标中的方向，若矩阵列向量描述相机坐标轴）
    const rotationCol3 = (rotation: any): Vec3 | null => {
        if (!rotation) return null;
        if (Array.isArray(rotation) && rotation.length === 3 && Array.isArray(rotation[0])) {
            return new Vec3(rotation[0][2], rotation[1][2], rotation[2][2]);
        }
        if (Array.isArray(rotation) && rotation.length === 9) {
            return new Vec3(rotation[2], rotation[5], rotation[8]);
        }
        return null;
    };

    // 从名称中提取末尾数字用于排序（比如 img_0012.png -> 12）。无数字则返回 Infinity。
    const extractIndex = (name: string): number => {
        if (!name) return Number.MAX_SAFE_INTEGER;
        const m = String(name).match(/(\d+)(?!.*\d)/);
        return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };

    // ===== Overlay removed - now managed by ImageContainer =====
    // ===== Expose camera metadata for ImageContainer =====
    events.function('camera.frameCameraId', (frame: number) => frameCameraIdMap.get(frame) ?? '');
    events.function('camera.frameRawPos', (frame: number) => frameRawPosMap.get(frame));
    events.function('camera.frameRawRot', (frame: number) => frameRawRotMap.get(frame));

    // independent caption box (always shown even without images), placed below Scene Manager panel
    let captionBox = document.getElementById('camera-caption-box') as HTMLDivElement | null;
    if (!captionBox) {
        captionBox = document.createElement('div');
        captionBox.id = 'camera-caption-box';
        captionBox.style.position = 'relative';
        captionBox.style.display = 'block';
        captionBox.style.width = '100%';
        captionBox.style.boxSizing = 'border-box';
        captionBox.style.margin = '6px auto';
        captionBox.style.textAlign = 'center';
        captionBox.style.pointerEvents = 'none';
        captionBox.style.background = 'rgba(0,0,0,0.95)';
        captionBox.style.borderRadius = '4px';
        captionBox.style.padding = '8px';
        captionBox.style.color = '#fff';
        captionBox.style.fontFamily = 'monospace';
        captionBox.style.fontSize = '12px';
        captionBox.style.lineHeight = '16px';
        captionBox.style.whiteSpace = 'pre-line';
        captionBox.textContent = '';
        const scenePanelEl = document.getElementById('scene-panel');
        if (scenePanelEl) {
            scenePanelEl.appendChild(captionBox);
        } else {
            document.body.appendChild(captionBox);
        }
    }

    const ensureCaptionPlacement = () => {
        if (!captionBox) return;
        const scenePanelEl = document.getElementById('scene-panel');
        if (scenePanelEl && captionBox.parentElement !== scenePanelEl) {
            scenePanelEl.appendChild(captionBox);
        }
    };

    // map frame -> camera id text for caption
    const frameCameraIdMap = new Map<number, string>();
    // map frame -> original camera position [x,y,z] from cameras.json (no coordinate flip)
    const frameRawPosMap = new Map<number, [number, number, number]>();
    // map frame -> original camera rotation 3x3 (flattened 9 numbers, row-major). null if unavailable
    const frameRawRotMap = new Map<number, number[] | null>();
    // map frame -> intrinsics (fx, fy)
    const frameFxMap = new Map<number, number>();
    const frameFyMap = new Map<number, number>();
    // cache: image name(lowercased, with/without ext) -> blob url
    const imageUrlByName = new Map<string, string>();

    // helpers for rotation transforms and intrinsics
    const toMat3 = (M: any): number[][] | null => {
        if (!M) return null;
        if (Array.isArray(M) && M.length === 3 && Array.isArray(M[0])) return M as number[][];
        if (Array.isArray(M) && M.length === 9) {
            return [
                [M[0], M[1], M[2]],
                [M[3], M[4], M[5]],
                [M[6], M[7], M[8]]
            ];
        }
        return null;
    };
    const convertRotationToPlayCanvas = (rot: any): number[][] | null => {
        const m = toMat3(rot);
        if (!m) return null;
        // cameras.json rotation 的列向量 = 相机坐标轴在世界系下的方向
        // supersplat/PlayCanvas 需要 (-x, -y, z) 轴翻转
        return [
            [-m[0][0], -m[0][1], -m[0][2]],
            [-m[1][0], -m[1][1], -m[1][2]],
            [ m[2][0],  m[2][1],  m[2][2]]
        ];
    };
    const flipXYRotation = convertRotationToPlayCanvas;
    const extractFxFyTop = (cam: any): { fx?: number, fy?: number } => {
        let fx: number | undefined;
        let fy: number | undefined;
        if (typeof cam?.fx === 'number') fx = cam.fx;
        if (typeof cam?.fy === 'number') fy = cam.fy;
        if ((!fx || !fy) && cam?.intrinsics) {
            if (typeof cam.intrinsics.fx === 'number') fx = cam.intrinsics.fx;
            if (typeof cam.intrinsics.fy === 'number') fy = cam.intrinsics.fy;
        }
        if ((!fx || !fy) && cam?.K) {
            const K = toMat3(cam.K);
            if (K) { fx = fx ?? K[0][0]; fy = fy ?? K[1][1]; }
        }
        return { fx, fy };
    };

    // quaternion helpers for rotation interpolation on SO(3)
    type QuatT = { x: number, y: number, z: number, w: number };
    const quatNormalize = (q: QuatT): QuatT => {
        const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
        return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
    };
    const quatFromMat3 = (m: number[][]): QuatT => {
        const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2];
        const m10 = m[1][0], m11 = m[1][1], m12 = m[1][2];
        const m20 = m[2][0], m21 = m[2][1], m22 = m[2][2];
        const tr = m00 + m11 + m22;
        let x: number, y: number, z: number, w: number;
        if (tr > 0) {
            const s = Math.sqrt(tr + 1.0) * 2; // s=4*w
            w = 0.25 * s;
            x = (m21 - m12) / s;
            y = (m02 - m20) / s;
            z = (m10 - m01) / s;
        } else if (m00 > m11 && m00 > m22) {
            const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2; // s=4*x
            w = (m21 - m12) / s;
            x = 0.25 * s;
            y = (m01 + m10) / s;
            z = (m02 + m20) / s;
        } else if (m11 > m22) {
            const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2; // s=4*y
            w = (m02 - m20) / s;
            x = (m01 + m10) / s;
            y = 0.25 * s;
            z = (m12 + m21) / s;
        } else {
            const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2; // s=4*z
            w = (m10 - m01) / s;
            x = (m02 + m20) / s;
            y = (m12 + m21) / s;
            z = 0.25 * s;
        }
        return quatNormalize({ x, y, z, w });
    };
    const quatSlerp = (a: QuatT, b: QuatT, t: number): QuatT => {
        // ensure shortest path
        let ax = a.x, ay = a.y, az = a.z, aw = a.w;
        let bx = b.x, by = b.y, bz = b.z, bw = b.w;
        let cos = ax * bx + ay * by + az * bz + aw * bw;
        if (cos < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; cos = -cos; }
        let k0: number, k1: number;
        if (1 - cos > 1e-6) {
            const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
            const sin = Math.sin(theta);
            k0 = Math.sin((1 - t) * theta) / sin;
            k1 = Math.sin(t * theta) / sin;
        } else {
            k0 = 1 - t; k1 = t;
        }
        const out = { x: ax * k0 + bx * k1, y: ay * k0 + by * k1, z: az * k0 + bz * k1, w: aw * k0 + bw * k1 };
        return quatNormalize(out);
    };
    const mat3FromQuat = (q: QuatT): number[][] => {
        const x = q.x, y = q.y, z = q.z, w = q.w;
        const xx = x * x, yy = y * y, zz = z * z;
        const xy = x * y, xz = x * z, yz = y * z;
        const wx = w * x, wy = w * y, wz = w * z;
        return [
            [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
            [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
            [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]
        ];
    };

    // === Image viewer removed - now managed by ImageContainer ===

    // 每个splat都有自己的poses数组
    const splatPoses = new Map<Splat, Pose[]>();
    // 最近一次加载的原始相机数据缓存（用于 SIM 切换时重建）
    let lastLoadedCameras: any[] | null = null;
    let lastLoadedSplat: Splat | null = null;

    let onTimelineChange: (frame: number) => void;
    // 跳转过程标记：避免 timeline 的 onTimelineChange 在跳转动画期间覆盖自定义插值的方向，造成画面与轴突变
    let jumpInProgress = false;
    let lastPoseForCaption: { position: Vec3, target: Vec3 } | null = null;
    let lastRotationForCaption: number[][] | null = null;

    // 获取当前选中splat的poses
    const getCurrentSplatPoses = (): Pose[] => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return [];
        }
        
        if (!splatPoses.has(selectedSplat)) {
            splatPoses.set(selectedSplat, []);
        }
        
        return splatPoses.get(selectedSplat)!;
    };

    const rebuildSpline = () => {
        const duration = events.invoke('timeline.frames');
        const poses = getCurrentSplatPoses();

        const orderedPoses = poses.slice()
        // filter out keys beyond the end of the timeline
        .filter(a => a.frame < duration)
        // order keys by time for spline
        .sort((a, b) => a.frame - b.frame);

        // construct the spline points to be interpolated
        const times = orderedPoses.map(p => p.frame);
        const points = [];
        for (let i = 0; i < orderedPoses.length; ++i) {
            const p = orderedPoses[i];
            points.push(p.position.x, p.position.y, p.position.z);
            points.push(p.target.x, p.target.y, p.target.z);
        }

        if (orderedPoses.length > 1) {
            // interpolate camera positions and camera target positions
            const spline = CubicSpline.fromPointsLooping(duration, times, points, -1);
            const result: number[] = [];
            const pose = { position: new Vec3(), target: new Vec3() };

            // handle application update tick
            onTimelineChange = (frame: number) => {
                const time = frame;

                // evaluate the spline at current time
                spline.evaluate(time, result);

                // set camera pose
                pose.position.set(result[0], result[1], result[2]);
                pose.target.set(result[3], result[4], result[5]);
                // record for realtime caption
                lastPoseForCaption = { position: pose.position.clone(), target: pose.target.clone() };
                // interpolate rotation on SO(3) between surrounding keyframes and linearly interpolate fx/fy
                let i0 = 0;
                while (i0 + 1 < orderedPoses.length && orderedPoses[i0 + 1].frame <= time) i0++;
                const i1 = Math.min(i0 + 1, orderedPoses.length - 1);
                const f0 = orderedPoses[i0]?.frame ?? time;
                const f1 = orderedPoses[i1]?.frame ?? time;
                const denom = Math.max(1, f1 - f0);
                const t = Math.max(0, Math.min(1, (time - f0) / denom));

                const raw0 = frameRawRotMap.get(f0);
                const raw1 = frameRawRotMap.get(f1);
                const m0 = raw0 ? flipXYRotation(raw0) : null;
                const m1 = raw1 ? flipXYRotation(raw1) : null;
                const haveBoth = !!(m0 && m1);

                // Interpolate in fov domain (radians). Use aspect to derive missing axis.
                let fx: number | undefined = undefined;
                let fy: number | undefined = undefined;
                const ts = (events.invoke('targetSize') || { width: 1, height: 1 }) as { width: number, height: number };
                const width = Math.max(1, ts.width|0);
                const height = Math.max(1, ts.height|0);
                const aspect = width / height;
                const fx0 = frameFxMap.get(f0); const fx1 = frameFxMap.get(f1);
                const fy0 = frameFyMap.get(f0); const fy1 = frameFyMap.get(f1);
                const fovPair = (fxv?: number, fyv?: number) => {
                    let fovX: number | undefined;
                    let fovY: number | undefined;
                    if (Number.isFinite(fxv as number)) {
                        fovX = 2 * Math.atan(width / (2 * (fxv as number)));
                        // derive Y from X if needed
                        if (!Number.isFinite(fyv as number)) {
                            fovY = 2 * Math.atan(Math.tan((fovX as number) / 2) / aspect);
                        }
                    }
                    if (Number.isFinite(fyv as number)) {
                        fovY = 2 * Math.atan(height / (2 * (fyv as number)));
                        if (!Number.isFinite(fovX as number)) {
                            fovX = 2 * Math.atan(Math.tan((fovY as number) / 2) * aspect);
                        }
                    }
                    return { fovX, fovY };
                };
                const p0 = fovPair(fx0, fy0);
                const p1 = fovPair(fx1, fy1);
                const lerp = (a?: number, b?: number) => (Number.isFinite(a as number) && Number.isFinite(b as number)) ? (a as number) * (1 - t) + (b as number) * t : (Number.isFinite(a as number) ? a : (Number.isFinite(b as number) ? b : undefined));
                const fovX = lerp(p0.fovX, p1.fovX);
                const fovY = lerp(p0.fovY, p1.fovY);
                if (Number.isFinite(fovX as number)) fx = width / (2 * Math.tan((fovX as number) / 2));
                if (Number.isFinite(fovY as number)) fy = height / (2 * Math.tan((fovY as number) / 2));

                if (jumpInProgress) {
                    // 跳转动画中：仅记录插值结果用于 caption，不改相机，避免方向被覆盖
                    if (m0 && m1) {
                        const q0 = quatFromMat3(m0);
                        const q1 = quatFromMat3(m1);
                        const qi = quatSlerp(q0, q1, t);
                        const mi = mat3FromQuat(qi);
                        lastRotationForCaption = mi.map(row => row.slice());
                    } else if (m0 || m1) {
                        lastRotationForCaption = (m0 ?? m1)?.map(row => row.slice()) ?? null;
                    } else {
                        lastRotationForCaption = null;
                    }
                } else if (haveBoth) {
                    const q0 = quatFromMat3(m0!);
                    const q1 = quatFromMat3(m1!);
                    const qi = quatSlerp(q0, q1, t);
                    const mi = mat3FromQuat(qi);
                    events.fire('camera.setView', {
                        position: pose.position,
                        target: pose.target,
                        rotation: mi,
                        fx,
                        fy,
                        speed: 0
                    });
                    lastRotationForCaption = mi.map(row => row.slice());
                } else if (m0 || m1) {
                    const mi = m0 ?? m1;
                    events.fire('camera.setView', {
                        position: pose.position,
                        target: pose.target,
                        rotation: mi,
                        fx,
                        fy,
                        speed: 0
                    });
                    lastRotationForCaption = mi?.map(row => row.slice()) ?? null;
                } else {
                    events.fire('camera.setPose', pose, 0);
                    lastRotationForCaption = null;
                }
            };
        } else {
            onTimelineChange = null;
        }
    };

    events.on('timeline.time', (time: number) => {
        onTimelineChange?.(time);
    });

    events.on('timeline.frame', (frame: number) => {
        onTimelineChange?.(frame);
    });

    // Overlay display now managed by ImageContainer

    // update independent caption: show position and live x/y/z axes from current camera rotation
    const updateCaptionForFrame = (_frame: number) => {
        ensureCaptionPlacement();
        if (!captionBox) return;
        const fmt = (v: Vec3) => `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`;
        // prefer current camera entity pose for realtime accuracy
        const cameraEntity = events.invoke('camera.entity');
        let pos: Vec3 | null = null;
        if (cameraEntity && typeof cameraEntity.getPosition === 'function') {
            const p = cameraEntity.getPosition();
            if (p) pos = new Vec3(p.x, p.y, p.z);
        }
        // fallback to pose.position if entity position not available
        if (!pos) {
            const pose = events.invoke('camera.getPose');
            if (pose?.position) pos = new Vec3(pose.position.x, pose.position.y, pose.position.z);
        }

        // derive axes from current quaternion every frame (works in free/orbit)
        let basis: number[][] | null = null;
        if (cameraEntity && typeof cameraEntity.getRotation === 'function') {
            const q = cameraEntity.getRotation?.();
            if (q) basis = mat3FromQuat({ x: q.x, y: q.y, z: q.z, w: q.w });
        }

        if (pos && basis) {
            const xAxis = new Vec3(basis[0][0], basis[1][0], basis[2][0]);
            const yAxis = new Vec3(basis[0][1], basis[1][1], basis[2][1]);
            const zAxis = new Vec3(basis[0][2], basis[1][2], basis[2][2]);
            captionBox.textContent = `position: ${fmt(pos)}\nx axis: ${fmt(xAxis)}\ny axis: ${fmt(yAxis)}\nz axis: ${fmt(zAxis)}`;
        }
    };

    events.on('timeline.frame', (frame: number) => {
        updateCaptionForFrame(frame);
    });

    // initialize caption immediately on scene load
    updateCaptionForFrame(0);

    // also update on each render to reflect user moving/rotating the camera
    events.on('prerender', () => updateCaptionForFrame(0));

    const addPose = (pose: Pose) => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat || pose.frame === undefined) {
            return false;
        }

        if (!splatPoses.has(selectedSplat)) {
            splatPoses.set(selectedSplat, []);
        }

        const poses = splatPoses.get(selectedSplat)!;

        // if a pose already exists at this time, update it
        const idx = poses.findIndex(p => p.frame === pose.frame);
        if (idx !== -1) {
            poses[idx] = pose;
        } else {
            poses.push(pose);
            events.fire('timeline.addKey', pose.frame);
        }

        rebuildSpline();
    };

    const removePose = (index: number) => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return;
        }

        const poses = splatPoses.get(selectedSplat);
        if (poses && index >= 0 && index < poses.length) {
            poses.splice(index, 1);

            // remove the timeline key
            rebuildSpline();
            events.fire('timeline.removeKey', index);
        }
    };

    events.function('camera.poses', () => {
        return getCurrentSplatPoses();
    });

    events.on('camera.addPose', (pose: Pose) => {
        addPose(pose);
    });

    events.on('timeline.add', (frame: number) => {
        // get the current camera pose
        const pose = events.invoke('camera.getPose');
        // also capture current rotation as a RAW-style 3x3 so that rotation interpolation works between keys
        try {
            const camEnt = events.invoke('camera.entity');
            if (camEnt && typeof camEnt.getRotation === 'function') {
                const q = camEnt.getRotation();
                if (q) {
                    // engine quat -> engine basis B (entity.forward = -Z)
                    const B = mat3FromQuat({ x: q.x, y: q.y, z: q.z, w: q.w });
                    // convert to pre-flip basis expected by setView pipeline: Mpre = [B0, -B1, -B2]
                    const Mpre = [
                        [ B[0][0], -B[0][1], -B[0][2] ],
                        [ B[1][0], -B[1][1], -B[1][2] ],
                        [ B[2][0], -B[2][1], -B[2][2] ]
                    ];
                    // store RAW-like matrix so later flipXYRotation(raw) == Mpre
                    const Raw = flipXYRotation(Mpre);
                    if (Raw) {
                        const flat = [
                            Raw[0][0], Raw[0][1], Raw[0][2],
                            Raw[1][0], Raw[1][1], Raw[1][2],
                            Raw[2][0], Raw[2][1], Raw[2][2]
                        ];
                        frameRawRotMap.set(frame, flat);
                    }
                }
            }
        } catch { /* noop */ }
        const poses = getCurrentSplatPoses();

        addPose({
            name: `camera_${poses.length}`,
            frame,
            position: pose.position,
            target: pose.target
        });
    });

    events.on('timeline.remove', (index: number) => {
        removePose(index);
    });

    events.on('timeline.frames', () => {
        rebuildSpline();
    });

    // 基于缓存数据重建关键帧（用于 SIM 开关即时生效）
    const rebuildFromCache = () => {
        const selectedSplat = lastLoadedSplat ?? (events.invoke('selection') as Splat);
        if (!lastLoadedCameras || !selectedSplat) return;

        // 复制 camera.loadKeys 中的选取、时间轴与帧分配逻辑
        let cameras: any[] = lastLoadedCameras.slice();

        // 排序（按名称数字）
        const extract = (name: string) => {
            if (!name) return Number.MAX_SAFE_INTEGER;
            const m = String(name).match(/(\d+)(?!.*\d)/);
            return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
        };
        const withNumeric = cameras.filter(c => Number.isFinite(extract(c?.img_name || c?.name)) && extract(c?.img_name || c?.name) !== Number.MAX_SAFE_INTEGER);
        if (withNumeric.length > 0) {
            cameras = cameras.slice().sort((a, b) => extract(a?.img_name || a?.name) - extract(b?.img_name || b?.name));
        }

        // 选择集合（受 simplify 开关影响）
        const totalCameras = cameras.length;
        const maxCameras = 10;
        let selectedCameras: any[] = [];
        if (!events.invoke('camera.simplify.get')) {
            selectedCameras = cameras;
        } else if (totalCameras <= maxCameras) {
            selectedCameras = cameras;
        } else {
            const indices: number[] = [];
            for (let i = 0; i < maxCameras; i++) {
                const index = Math.round(i * (totalCameras - 1) / (maxCameras - 1));
                if (!indices.includes(index)) indices.push(index);
            }
            selectedCameras = indices.map(i => cameras[i]);
        }

        // 场景中心（全部相机）
        const sceneCenter = new Vec3(0, 0, 0);
        let validCount = 0;
        cameras.forEach(c => {
            if (c.position && Array.isArray(c.position)) { sceneCenter.add(new Vec3(c.position)); validCount++; }
        });
        if (validCount > 0) sceneCenter.mulScalar(1 / validCount);

        // 平均距离（基于所选集合）
        let averageDistance = 0;
        if (selectedCameras.length > 0) {
            selectedCameras.forEach(c => {
                if (c.position && Array.isArray(c.position)) averageDistance += new Vec3(c.position).distance(sceneCenter);
            });
            averageDistance /= Math.max(1, selectedCameras.length);
            averageDistance = Math.max(averageDistance * 0.5, 1.0);
        } else {
            averageDistance = 5.0;
        }

        // 时间轴自适应：相邻至少 18 帧
        const minGap = 18;
        const n = Math.max(1, selectedCameras.length);
        const desiredSteps = Math.max(1, n - 1);
        const baseFrames = Math.max(1, events.invoke('timeline.frames') || 1200);
        const step = (n > 1) ? Math.max(minGap, Math.ceil((baseFrames - 1) / desiredSteps)) : 1;
        const finalFrames = (n > 1) ? (step * desiredSteps + 1) : baseFrames;
        events.fire('timeline.setFrames', finalFrames);
        const frameForIndex = (i: number) => (n > 1) ? (i * step) : 0;

        // 清空并重建映射
        const newPoses: Pose[] = [];
        events.invoke('images.clear');
        frameCameraIdMap.clear();
        frameRawPosMap.clear();
        frameRawRotMap.clear();
        frameFxMap.clear();
        frameFyMap.clear();
        frameRawPosMap.clear();
        frameRawRotMap.clear();

        // rotation 第三行（相机前向）提取函数已在之前定义：rotationCol3
        selectedCameras.forEach((cameraData: any, index: number) => {
            const position = new Vec3(cameraData.position);
            let outPosition = new Vec3(cameraData.position);
            let outTarget: Vec3;
            if (cameraData.target && Array.isArray(cameraData.target)) {
                outTarget = new Vec3(cameraData.target);
            } else if (cameraData.rotation) {
                const z = rotationCol3(cameraData.rotation);
                if (z) {
                    const toCenter = sceneCenter.clone().sub(position);
                    const dot = toCenter.dot(z);
                    const targetFromRot = position.clone().add(z.clone().mulScalar(dot));
                    outPosition = new Vec3(-position.x, -position.y, position.z);
                    outTarget = new Vec3(-targetFromRot.x, -targetFromRot.y, targetFromRot.z);
                } else {
                    outTarget = sceneCenter.clone();
                }
            } else {
                outTarget = sceneCenter.clone();
            }

            const frame = frameForIndex(index);
            const imageName = cameraData.img_name || cameraData.name;
            if (imageName) events.fire('images.setFrameName', frame, String(imageName));
            const idText = Number.isFinite(cameraData.id) ? String(cameraData.id) : (cameraData.name ?? imageName ?? `#${index}`);
            frameCameraIdMap.set(frame, idText);
            // store raw position/rotation (no coordinate flip)
            if (cameraData.position && Array.isArray(cameraData.position) && cameraData.position.length === 3) {
                frameRawPosMap.set(frame, [cameraData.position[0], cameraData.position[1], cameraData.position[2]]);
            }
            if (cameraData.rotation) {
                let rot: number[] | null = null;
                if (Array.isArray(cameraData.rotation) && cameraData.rotation.length === 3 && Array.isArray(cameraData.rotation[0])) {
                    rot = [
                        cameraData.rotation[0][0], cameraData.rotation[0][1], cameraData.rotation[0][2],
                        cameraData.rotation[1][0], cameraData.rotation[1][1], cameraData.rotation[1][2],
                        cameraData.rotation[2][0], cameraData.rotation[2][1], cameraData.rotation[2][2]
                    ];
                } else if (Array.isArray(cameraData.rotation) && cameraData.rotation.length === 9) {
                    rot = cameraData.rotation.slice(0, 9);
                }
                frameRawRotMap.set(frame, rot);
            } else {
                frameRawRotMap.set(frame, null);
            }

            // 记录 fx/fy
            const intr = extractFxFyTop(cameraData);
            if (Number.isFinite(intr.fx)) frameFxMap.set(frame, intr.fx as number);
            if (Number.isFinite(intr.fy)) frameFyMap.set(frame, intr.fy as number);

            newPoses.push({
                name: cameraData.name || cameraData.img_name || `camera_${index}`,
                frame,
                position: outPosition,
                target: outTarget
            });
        });

        splatPoses.set(selectedSplat, newPoses);
        rebuildSpline();
        const framesForTimeline = newPoses.map(p => p.frame);
        events.fire('timeline.setSplatKeys', selectedSplat, framesForTimeline);
        events.fire('timeline.selectionChanged');
        // 触发images.ts中的匹配逻辑
        events.fire('images.matchFrames');
    };

    // 简化开关变更时，立即重建
    events.on('camera.simplify.set', () => {
        rebuildFromCache();
    });

    // 当选择变化时，重建spline以适应新选中splat的poses
    events.on('selection.changed', () => {
        rebuildSpline();
        // clear overlay images and planned name mapping for new selection
        events.invoke('images.clear');
        frameCameraIdMap.clear();
        frameFxMap.clear();
        frameFyMap.clear();
        if (captionBox) captionBox.textContent = '';

        // 若有进行中的就近跳转动画，切换选中时终止
        if (jumpAnimHandle) {
            jumpAnimHandle.off();
            jumpAnimHandle = null;
        }
    });

    // 当splat被移除时，清理其poses数据
    events.on('scene.elementRemoved', (element: any) => {
        if (element.type === ElementType.splat) {
            splatPoses.delete(element as Splat);
            // 若场景中已无 splat，清理数据
            const allSplats = (events.invoke('scene.allSplats') as Splat[]) || [];
            if (!allSplats || allSplats.length === 0) {
                events.invoke('images.clear');
                frameCameraIdMap.clear();
                frameRawPosMap.clear();
                frameRawRotMap.clear();
                frameFxMap.clear();
                frameFyMap.clear();
            }
        }
    });

    // 当场景即将清理时，提前清理资源
    events.on('scene.clearing', () => {
        jumpAnimHandle?.off();
        jumpAnimHandle = null;
        jumpInProgress = false;
    });

    // 保存当前选中splat的关键帧到JSON文件
    events.on('camera.saveKeys', () => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            events.invoke('showPopup', {
                type: 'error',
                header: '保存失败',
                message: '请先选择一个Splat对象'
            });
            return;
        }

        const poses = getCurrentSplatPoses();
        if (poses.length === 0) {
            events.invoke('showPopup', {
                type: 'error',
                header: '保存失败',
                message: '当前选中的Splat没有关键帧数据'
            });
            return;
        }
        // 导出需求：不再包含 target；输出原始 3dgs 坐标系下的 position、rotation(3x3)、fx、fy。
        // 我们在加载时对 position 做了 (-x,-y,z) 翻转，这里需翻回；rotation 原始矩阵已缓存在 frameRawRotMap。
        const to3dgsPos = (frame: number, edited: Vec3): [number, number, number] => {
            const raw = frameRawPosMap.get(frame);
            if (raw && raw.length === 3) return [raw[0], raw[1], raw[2]];
            // 若无原始缓存，按加载时的转换逆操作：当前 pose.position 是已翻转后的 (-x,-y,z)
            return [-edited.x, -edited.y, edited.z];
        };
        const to3dgsRot = (frame: number): number[][] | null => {
            const raw = frameRawRotMap.get(frame);
            if (!raw) return null;
            if (raw.length === 9) {
                return [
                    [raw[0], raw[1], raw[2]],
                    [raw[3], raw[4], raw[5]],
                    [raw[6], raw[7], raw[8]]
                ];
            }
            // 已是 3x3 嵌套时（不太可能，因为存的是扁平），直接返回
            return null;
        };
        const data = {
            version: 2,
            splatName: selectedSplat.name,
            frameCount: events.invoke('timeline.frames'),
            frameRate: events.invoke('timeline.frameRate'),
            timestamp: new Date().toISOString(),
            poses: poses.map((pose) => {
                const position = to3dgsPos(pose.frame, pose.position);
                const rotation = to3dgsRot(pose.frame); // 原始 cameras.json 旋转（列向量表示相机坐标轴）
                const fx = frameFxMap.get(pose.frame);
                const fy = frameFyMap.get(pose.frame);
                return {
                    name: pose.name,
                    frame: pose.frame,
                    position,
                    rotation: rotation ?? undefined,
                    fx: Number.isFinite(fx) ? fx : undefined,
                    fy: Number.isFinite(fy) ? fy : undefined
                };
            })
        };

        // 创建并下载JSON文件
        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${selectedSplat.name}_keyframes.json`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // 显示成功消息
        events.invoke('showPopup', {
            type: 'info',
            header: '保存成功',
            message: `已保存 ${selectedSplat.name} 的 ${poses.length} 个关键帧 (version=2, 含原始 rotation / fx / fy)\n文件名: ${selectedSplat.name}_keyframes.json\n\n建议将文件保存到项目的 keyframes/ 目录下`
        });
    });

    // 加载关键帧文件
    events.on('camera.loadKeys', () => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            events.invoke('showPopup', {
                type: 'error',
                header: '加载失败',
                message: '请先选择一个Splat对象'
            });
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';

        input.onchange = (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const result = e.target?.result as string;
                    const data = JSON.parse(result);

                    // 支持两种格式：新的相机数组格式和原有的poses格式
                    let cameras: any[] = [];

                    if (Array.isArray(data)) {
                        // 格式1: 直接是相机数组，适用于原始3dgs导出的cameras.json格式
                        cameras = data;
                    } else if (data.poses && Array.isArray(data.poses)) {
                        // 格式2: 原有的poses格式
                        cameras = data.poses;
                    } else {
                        events.invoke('showPopup', {
                            type: 'error',
                            header: '加载失败',
                            message: '不支持的文件格式：应该是相机数组或poses数组'
                        });
                        return;
                    }

                    // 验证相机数据格式
                    for (const camera of cameras) {
                        if (!camera.position || !Array.isArray(camera.position) || camera.position.length !== 3) {
                            events.invoke('showPopup', {
                                type: 'error',
                                header: '加载失败',
                                message: '相机数据格式错误：position字段应为3元素数组'
                            });
                            return;
                        }

                        // 检查是否有rotation或target信息
                        if (!camera.rotation && !camera.target) {
                            events.invoke('showPopup', {
                                type: 'warning',
                                header: '注意',
                                message: '相机数据缺少rotation或者是target信息，将使用默认朝向'
                            });
                        }
                    }

                    // 始终按图片名称中的数字升序排序；无数字的放在末尾
                    const withNumeric = cameras.filter(c => Number.isFinite(extractIndex(c?.img_name || c?.name)) && extractIndex(c?.img_name || c?.name) !== Number.MAX_SAFE_INTEGER);
                    if (withNumeric.length > 0) {
                        cameras = cameras.slice().sort((a, b) => {
                            const ia = extractIndex(a?.img_name || a?.name);
                            const ib = extractIndex(b?.img_name || b?.name);
                            return ia - ib;
                        });
                    }

                    // 智能选取相机视角，确保平滑过渡
                    const totalCameras = cameras.length;
                    const maxCameras = 10; // 最多选择10个相机
                    
                    let selectedCameras: any[] = [];
                    
                    if (!events.invoke('camera.simplify.get')) {
                        // 默认：不开简化——使用全部相机
                        selectedCameras = cameras;
                    } else if (totalCameras <= maxCameras) {
                        // 简化且不多于10个：全部使用
                        selectedCameras = cameras;
                    } else {
                        // 简化且超过10个：均匀分布选择10个
                        const indices: number[] = [];
                        for (let i = 0; i < maxCameras; i++) {
                            const index = Math.round(i * (totalCameras - 1) / (maxCameras - 1));
                            if (!indices.includes(index)) {
                                indices.push(index);
                            }
                        }
                        selectedCameras = indices.map(i => cameras[i]);
                    }

                    // 缓存源数据与选中 splat，用于 SIM 开关即时重建
                    lastLoadedCameras = cameras;
                    lastLoadedSplat = selectedSplat;

                    // 清除当前选中splat的关键帧
                    splatPoses.set(selectedSplat, []);

                    // 计算场景中心点（所有相机位置的平均值）——注意：使用“全部相机”而非仅选中的 10 个
                    const sceneCenter = new Vec3(0, 0, 0);
                    let validCameraCount = 0;
                    cameras.forEach((camera: any) => {
                        if (camera.position && Array.isArray(camera.position)) {
                            sceneCenter.add(new Vec3(camera.position));
                            validCameraCount++;
                        }
                    });
                    if (validCameraCount > 0) {
                        sceneCenter.mulScalar(1 / validCameraCount);
                    }

                    // 计算平均距离用于确定target距离
                    let averageDistance = 0;
                    if (validCameraCount > 0) {
                        selectedCameras.forEach((camera: any) => {
                            if (camera.position && Array.isArray(camera.position)) {
                                const pos = new Vec3(camera.position);
                                averageDistance += pos.distance(sceneCenter);
                            }
                        });
                        averageDistance /= Math.max(1, selectedCameras.length);
                        // 使用平均距离的一半作为target距离，确保target在场景内部
                        averageDistance = Math.max(averageDistance * 0.5, 1.0);
                    } else {
                        averageDistance = 5.0; // 默认距离
                    }

                    // 加载新的关键帧
                    const newPoses: Pose[] = [];
                    // 尝试在加载时用 setView 恢复 FOV/roll（仅首次调用一次）
                    let didSetInitialView = false;
                    
                    // 自适应调整 timeline 总帧数，保证相邻关键帧至少 18 帧
                    const minGap = 18;
                    const n = Math.max(1, selectedCameras.length);
                    const desiredSteps = Math.max(1, n - 1);
                    const baseFrames = Math.max(1, events.invoke('timeline.frames') || 1200);
                    const step = (n > 1) ? Math.max(minGap, Math.ceil((baseFrames - 1) / desiredSteps)) : 1;
                    const finalFrames = (n > 1) ? (step * desiredSteps + 1) : baseFrames;
                    events.fire('timeline.setFrames', finalFrames);

                    const frameForIndex = (i: number) => (n > 1) ? (i * step) : 0;

                    // reset maps for current selection before filling
                    events.invoke('images.clear');
                    frameCameraIdMap.clear();
                    frameRawPosMap.clear();
                    frameRawRotMap.clear();

                    // 提取 fx, fy（多种来源）
                    const extractFxFy = (cam: any): { fx?: number, fy?: number } => {
                        let fx: number | undefined;
                        let fy: number | undefined;
                        if (typeof cam.fx === 'number') fx = cam.fx;
                        if (typeof cam.fy === 'number') fy = cam.fy;
                        if ((!fx || !fy) && cam.intrinsics) {
                            if (typeof cam.intrinsics.fx === 'number') fx = cam.intrinsics.fx;
                            if (typeof cam.intrinsics.fy === 'number') fy = cam.intrinsics.fy;
                        }
                        const toMat3 = (K: any): number[][] | null => {
                            if (!K) return null;
                            if (Array.isArray(K) && K.length === 3 && Array.isArray(K[0])) return K as number[][];
                            if (Array.isArray(K) && K.length === 9) {
                                return [
                                    [K[0], K[1], K[2]],
                                    [K[3], K[4], K[5]],
                                    [K[6], K[7], K[8]]
                                ];
                            }
                            return null;
                        };
                        if ((!fx || !fy) && cam.K) {
                            const K = toMat3(cam.K);
                            if (K) { fx = K[0][0]; fy = K[1][1]; }
                        }
                        return { fx, fy };
                    };

                    // 将旋转矩阵做坐标系转换（-x, -y, z）：左乘 T=diag(-1,-1,1)
                    const transformRotationFlipXY = (rot: any): number[][] | null => convertRotationToPlayCanvas(rot);

                    selectedCameras.forEach((cameraData: any, index: number) => {
                        // 基于 supersplat 的逻辑：当使用 position + rotation 时，
                        // 用旋转矩阵的第 3 列 z 作为前向，计算 (sceneCenter - p) 在 z 上的投影，
                        // 得到 target = p + dot * z；随后做坐标系转换：x/y 取反，z 保持。
                        const position = new Vec3(cameraData.position);

                        let outPosition = new Vec3(cameraData.position);
                        let outTarget: Vec3;

                        if (cameraData.target && Array.isArray(cameraData.target)) {
                            // 若有显式 target，保持原有逻辑（不修改坐标系约定）
                            outTarget = new Vec3(cameraData.target);
                        } else if (cameraData.rotation) {
                            // 取旋转矩阵第 3 列作为前向（兼容 3x3 或 9 元素数组）
                            const z = rotationCol3(cameraData.rotation);
                            if (z) {
                                const toCenter = sceneCenter.clone().sub(position);
                                const dot = toCenter.dot(z);
                                const targetFromRot = position.clone().add(z.clone().mulScalar(dot));

                                // 坐标系转换：与 supersplat 一致（-x, -y, z）
                                outPosition = new Vec3(-position.x, -position.y, position.z);
                                outTarget = new Vec3(-targetFromRot.x, -targetFromRot.y, targetFromRot.z);
                            } else {
                                outTarget = sceneCenter.clone();
                            }
                        } else {
                            // 无 rotation 与 target，指向场景中心
                            outTarget = sceneCenter.clone();
                        }

                        // 在首次可用时调用 setView 以恢复 FOV/roll
                        if (!didSetInitialView) {
                            const rotT = transformRotationFlipXY(cameraData.rotation);
                            const { fx, fy } = extractFxFy(cameraData);
                            if (rotT) {
                                // 若有显式 target 则一并变换
                                let tgtForView: Vec3 | undefined = undefined;
                                if (cameraData.target && Array.isArray(cameraData.target)) {
                                    const t = cameraData.target;
                                    tgtForView = new Vec3(-t[0], -t[1], t[2]);
                                } else if (outTarget) {
                                    tgtForView = outTarget.clone();
                                }
                                const posForView = new Vec3(-position.x, -position.y, position.z);
                                events.fire('camera.setView', {
                                    position: posForView,
                                    target: tgtForView,
                                    rotation: rotT,
                                    fx,
                                    fy,
                                    speed: 0
                                });
                                lastRotationForCaption = rotT.map(row => row.slice());
                                didSetInitialView = true;
                            }
                        }

                        // 均匀分布帧号，确保平滑过渡
                        const frame = frameForIndex(index);

                        // 记录期望的图片名称（用于稍后独立上传匹配）
                        const imageName = cameraData.img_name || cameraData.name;
                        if (imageName) {
                            events.fire('images.setFrameName', frame, String(imageName));
                        }
                        // store camera id for caption (prefer numeric id)
                        const idText = Number.isFinite(cameraData.id) ? String(cameraData.id) : (cameraData.name ?? imageName ?? `#${index}`);
                        frameCameraIdMap.set(frame, idText);
                        // store raw position / rotation for caption
                        if (cameraData.position && Array.isArray(cameraData.position) && cameraData.position.length === 3) {
                            frameRawPosMap.set(frame, [cameraData.position[0], cameraData.position[1], cameraData.position[2]]);
                        }
                        if (cameraData.rotation) {
                            let rot: number[] | null = null;
                            if (Array.isArray(cameraData.rotation) && cameraData.rotation.length === 3 && Array.isArray(cameraData.rotation[0])) {
                                rot = [
                                    cameraData.rotation[0][0], cameraData.rotation[0][1], cameraData.rotation[0][2],
                                    cameraData.rotation[1][0], cameraData.rotation[1][1], cameraData.rotation[1][2],
                                    cameraData.rotation[2][0], cameraData.rotation[2][1], cameraData.rotation[2][2]
                                ];
                            } else if (Array.isArray(cameraData.rotation) && cameraData.rotation.length === 9) {
                                rot = cameraData.rotation.slice(0, 9);
                            }
                            frameRawRotMap.set(frame, rot);
                        } else {
                            frameRawRotMap.set(frame, null);
                        }

                        newPoses.push({
                            name: cameraData.name || cameraData.img_name || `camera_${index}`,
                            frame: frame,
                            position: outPosition,
                            target: outTarget
                        });
                    });

                    splatPoses.set(selectedSplat, newPoses);
                    // notify other modules that camera poses were loaded
                    try {
                        // build converted cameras in gs_editor coord system: (-x, -y, z)
                        const converted = cameras.map((c: any) => {
                            const out: any = Object.assign({}, c);
                            if (c.position && Array.isArray(c.position) && c.position.length >= 3) {
                                out.position = [-c.position[0], -c.position[1], c.position[2]];
                            }
                            if (c.target && Array.isArray(c.target) && c.target.length >= 3) {
                                out.target = [-c.target[0], -c.target[1], c.target[2]];
                            }
                            if (c.rotation) {
                                const rot = flipXYRotation(c.rotation);
                                out.rotation = rot ?? c.rotation;
                            }
                            return out;
                        });
                        events.fire('camera.posesLoaded', converted);
                    } catch (e) {
                        // noop
                    }
                    rebuildSpline();

                    // 同步时间轴关键帧标记（与手动添加一致）
                    const framesForTimeline = newPoses.map(p => p.frame);
                    events.fire('timeline.setSplatKeys', selectedSplat, framesForTimeline);
                    events.fire('timeline.selectionChanged');
                    // show a small info popup with how many keyframes were loaded
                    events.invoke('showPopup', {
                        type: 'info',
                        header: '加载完成',
                        message: `已加载 ${newPoses.length} 个关键帧。`
                    });

                    // 保留：不在此处弹出文件夹选择。请使用时间轴上的“上传图片文件夹”按钮进行独立上传。

                } catch (error) {
                    events.invoke('showPopup', {
                        type: 'error',
                        header: '加载失败',
                        message: `文件解析错误: ${error.message || error}`
                    });
                }
            };
            reader.readAsText(file);
        };

        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    });

    // 自动加载 cameras.json 内容（与 camera.loadKeys 逻辑类似，但直接接收数组）
    events.on('camera.autoLoadCameras', (camerasData: any[]) => {
        if (!Array.isArray(camerasData) || camerasData.length === 0) {
            console.warn('[autoLoadCameras] invalid camerasData');
            return;
        }
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            console.warn('[autoLoadCameras] no splat selected');
            return;
        }
        // 复制 camera.loadKeys 里排序 + 选取 + 时间轴分配逻辑（简化：不重复 popup 提示）
        const extractIdx = (name: string) => {
            if (!name) return Number.MAX_SAFE_INTEGER;
            const m = String(name).match(/(\d+)(?!.*\d)/);
            return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
        };
        let cameras: any[] = camerasData.slice();
        const withNumeric = cameras.filter(c => Number.isFinite(extractIdx(c?.img_name || c?.name)) && extractIdx(c?.img_name || c?.name) !== Number.MAX_SAFE_INTEGER);
        if (withNumeric.length > 0) {
            cameras = cameras.slice().sort((a, b) => extractIdx(a?.img_name || a?.name) - extractIdx(b?.img_name || b?.name));
        }
        const total = cameras.length;
        const maxCameras = 10;
        let selectedCameras: any[] = [];
        if (!events.invoke('camera.simplify.get')) selectedCameras = cameras;
        else if (total <= maxCameras) selectedCameras = cameras; else {
            const indices: number[] = [];
            for (let i = 0; i < maxCameras; i++) {
                const idx = Math.round(i * (total - 1) / (maxCameras - 1));
                if (!indices.includes(idx)) indices.push(idx);
            }
            selectedCameras = indices.map(i => cameras[i]);
        }
        // 场景中心（全部相机）
        const sceneCenter = new Vec3(0, 0, 0);
        let validCount = 0;
        cameras.forEach(c => { if (c.position && Array.isArray(c.position)) { sceneCenter.add(new Vec3(c.position)); validCount++; } });
        if (validCount > 0) sceneCenter.mulScalar(1 / validCount);
        // 时间轴帧分配
        const minGap = 18;
        const n = Math.max(1, selectedCameras.length);
        const desiredSteps = Math.max(1, n - 1);
        const baseFrames = Math.max(1, events.invoke('timeline.frames') || 1200);
        const step = (n > 1) ? Math.max(minGap, Math.ceil((baseFrames - 1) / desiredSteps)) : 1;
        const finalFrames = (n > 1) ? (step * desiredSteps + 1) : baseFrames;
        events.fire('timeline.setFrames', finalFrames);
        const frameForIndex = (i: number) => (n > 1) ? (i * step) : 0;
        // 清空旧数据
        splatPoses.set(selectedSplat, []);
        events.invoke('images.clear');
        frameCameraIdMap.clear();
        frameRawPosMap.clear();
        frameRawRotMap.clear();
        frameFxMap.clear();
        frameFyMap.clear();
        // 构建新 poses
        const newPoses: Pose[] = [];
        selectedCameras.forEach((cam: any, index: number) => {
            if (!cam.position || !Array.isArray(cam.position) || cam.position.length !== 3) return;
            const position = new Vec3(cam.position);
            let outPosition = new Vec3(cam.position);
            let outTarget: Vec3;
            if (cam.target && Array.isArray(cam.target)) {
                outTarget = new Vec3(cam.target);
            } else if (cam.rotation) {
                const z = rotationCol3(cam.rotation);
                if (z) {
                    const toCenter = sceneCenter.clone().sub(position);
                    const dot = toCenter.dot(z);
                    const targetFromRot = position.clone().add(z.clone().mulScalar(dot));
                    outPosition = new Vec3(-position.x, -position.y, position.z);
                    outTarget = new Vec3(-targetFromRot.x, -targetFromRot.y, targetFromRot.z);
                } else {
                    outTarget = sceneCenter.clone();
                }
            } else {
                outTarget = sceneCenter.clone();
            }
            const frame = frameForIndex(index);
            const imageName = cam.img_name || cam.name;
            if (imageName) events.fire('images.setFrameName', frame, String(imageName));
            const idText = Number.isFinite(cam.id) ? String(cam.id) : (cam.name ?? imageName ?? `#${index}`);
            frameCameraIdMap.set(frame, idText);
            if (cam.position && Array.isArray(cam.position) && cam.position.length === 3) {
                frameRawPosMap.set(frame, [cam.position[0], cam.position[1], cam.position[2]]);
            }
            if (cam.rotation) {
                let rot: number[] | null = null;
                if (Array.isArray(cam.rotation) && cam.rotation.length === 3 && Array.isArray(cam.rotation[0])) {
                    rot = [
                        cam.rotation[0][0], cam.rotation[0][1], cam.rotation[0][2],
                        cam.rotation[1][0], cam.rotation[1][1], cam.rotation[1][2],
                        cam.rotation[2][0], cam.rotation[2][1], cam.rotation[2][2]
                    ];
                } else if (Array.isArray(cam.rotation) && cam.rotation.length === 9) {
                    rot = cam.rotation.slice(0, 9);
                }
                frameRawRotMap.set(frame, rot);
            } else {
                frameRawRotMap.set(frame, null);
            }
            const intr = extractFxFyTop(cam);
            if (Number.isFinite(intr.fx)) frameFxMap.set(frame, intr.fx as number);
            if (Number.isFinite(intr.fy)) frameFyMap.set(frame, intr.fy as number);
            newPoses.push({
                name: cam.name || cam.img_name || `camera_${index}`,
                frame,
                position: outPosition,
                target: outTarget
            });
        });
        splatPoses.set(selectedSplat, newPoses);
        rebuildSpline();
        // notify other modules that camera poses were auto-loaded
        try {
            const converted = cameras.map((c: any) => {
                const out: any = Object.assign({}, c);
                if (c.position && Array.isArray(c.position) && c.position.length >= 3) {
                    out.position = [-c.position[0], -c.position[1], c.position[2]];
                }
                if (c.target && Array.isArray(c.target) && c.target.length >= 3) {
                    out.target = [-c.target[0], -c.target[1], c.target[2]];
                }
                if (c.rotation) {
                    const rot = flipXYRotation(c.rotation);
                    out.rotation = rot ?? c.rotation;
                }
                return out;
            });
            events.fire('camera.posesLoaded', converted);
        } catch (e) {
            // noop
        }
        const framesForTimeline = newPoses.map(p => p.frame);
        events.fire('timeline.setSplatKeys', selectedSplat, framesForTimeline);
        events.fire('timeline.selectionChanged');
        // 若未启用 autoplay，则模拟“下一关键帧”一次以套用首帧视角
        if (!(window as any).__GS_AUTOPLAY__) {
            const sortedFrames = framesForTimeline.slice().sort((a, b) => a - b);
            const targetFrame = sortedFrames.length >= 2 ? sortedFrames[1] : (sortedFrames[0] ?? 0);
            setTimeout(() => {
                try {
                    events.fire('timeline.setFrame', targetFrame);
                } catch (e) {
                    console.warn('[autoLoadCameras] jump first keyframe failed', e);
                }
            }, 0);
        }
        // 不再在此处直接触发 images.autoLoadFromBase，避免与 runPreload 内重复触发导致并发双重 onload
        console.log(`[autoLoadCameras] loaded ${newPoses.length} poses`);
        // 若 URL 指定 autoplay，则在关键帧建立完成后启动播放
        if ((window as any).__GS_AUTOPLAY__) {
            setTimeout(() => {
                try {
                    events.fire('timeline.setPlaying', true);
                    console.log('[autoLoadCameras] autoplay timeline');
                } catch (e) {
                    console.warn('[autoLoadCameras] autoplay failed', e);
                }
            }, 0);
        }
    });

    // 自动图片加载逻辑已迁移至 images.ts（统一管理图片与 UI 刷新）

    // doc

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        const result: any[] = [];

        // 序列化所有splat的poses数据
        splatPoses.forEach((poses, splat) => {
            if (poses.length > 0) {
                result.push({
                    name: splat.name,
                    poses: poses.map((pose) => {
                        return {
                            name: pose.name,
                            frame: pose.frame,
                            position: pack3(pose.position),
                            target: pack3(pose.target)
                        };
                    })
                });
            }
        });

        return result;
    });

    events.function('docDeserialize.poseSets', (poseSets: any[]) => {
        if (poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');

        // 延迟恢复，等待所有splat加载完成
        setTimeout(() => {
            const allSplats = events.invoke('scene.allSplats') as Splat[];
            
            poseSets.forEach((poseSet: any) => {
                // 根据名称找到对应的splat
                const splat = allSplats.find(s => s.name === poseSet.name);
                if (splat && poseSet.poses) {
                    const poses: Pose[] = [];
                    poseSet.poses.forEach((docPose: any, index: number) => {
                        poses.push({
                            name: docPose.name,
                            frame: docPose.frame ?? (index * fps),
                            position: new Vec3(docPose.position),
                            target: new Vec3(docPose.target)
                        });
                    });
                    splatPoses.set(splat, poses);
                }
            });

            // 如果有当前选择，重建spline
            const currentSelection = events.invoke('selection') as Splat;
            if (currentSelection && splatPoses.has(currentSelection)) {
                rebuildSpline();
            }
        }, 100);
    });

    // 监听 .ply 文件上传事件（仅确保面板可见，内容由统一的实时更新驱动）
    events.on('file.upload', (file) => {
        if (file.name.endsWith('.ply')) {
            captionBox!.style.display = 'block';
        }
    });

    // 跳转到最近关键帧事件处理
    let jumpAnimHandle: EventHandle | null = null;
    events.on('camera.jumpToNearestPose', () => {
        // 获取当前选中 splat 的关键帧列表
        const poses = getCurrentSplatPoses();
        if (!poses || poses.length === 0) {
            events.invoke('showPopup', {
                type: 'warning',
                header: '没有关键帧',
                message: '当前选中的 Splat 没有关键帧，请先加载或添加关键帧。'
            });
            return;
        }

        // 获取当前相机位置
        const camPose = events.invoke('camera.getPose');
        if (!camPose || !camPose.position) return;

        const camPos = new Vec3(camPose.position.x, camPose.position.y, camPose.position.z);

        // 找到 position 最近的关键帧
        let nearest: Pose | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const p of poses) {
            const d = camPos.distance(p.position);
            if (d < bestDist) {
                bestDist = d;
                nearest = p;
            }
        }

        if (!nearest) return;

        // 若正在播放，先暂停，避免干扰
        if (events.invoke('timeline.playing')) {
            events.fire('timeline.setPlaying', false);
        }

        // 若有未结束的跳转，先取消
        if (jumpAnimHandle) {
            jumpAnimHandle.off();
            jumpAnimHandle = null;
        }

        const durationSec = 3.0;
        const fixedStep = 1 / 60; // 60fps
        const startFrame: number = events.invoke('timeline.frame');
        const endFrame: number = nearest.frame;
        const frameDelta = endFrame - startFrame;

        // 明确：始终从“当前相机姿态”插值到“最近关键帧姿态”
        const startPoseNow = events.invoke('camera.getPose');
        const startPos = new Vec3(startPoseNow.position.x, startPoseNow.position.y, startPoseNow.position.z);
        const startTgt = new Vec3(startPoseNow.target.x, startPoseNow.target.y, startPoseNow.target.z);

        // 起始旋转：取当前相机实体四元数；注意 entity.forward = -Z（引擎空间）。
        // 为与 setView 的“预翻转空间”（[right, up, forward]，随后在 setView 中做 [r, -u, -f]）一致，
        // 需要把引擎四元数先转成矩阵 B，再还原到预翻转基 Mpre=[B0, -B1, -B2]，再生成 qStart。
        const camEnt = events.invoke('camera.entity');
        let qStart: QuatT | null = null;
        if (camEnt && typeof camEnt.getRotation === 'function') {
            const q = camEnt.getRotation();
            if (q) {
                const B = mat3FromQuat({ x: q.x, y: q.y, z: q.z, w: q.w });
                const Mpre = [
                    [ B[0][0], -B[0][1], -B[0][2] ],
                    [ B[1][0], -B[1][1], -B[1][2] ],
                    [ B[2][0], -B[2][1], -B[2][2] ]
                ];
                qStart = quatFromMat3(Mpre);
            }
        }
        if (!qStart) {
            // fallback: build look-at orientation from start forward
            const fwd = startTgt.clone().sub(startPos).normalize();
            const up = new Vec3(0, 1, 0);
            let right = new Vec3().cross(up, fwd);
            if (right.length() < 1e-4) {
                // choose alternate up if degenerate
                up.set(0, 0, 1);
                right = new Vec3().cross(up, fwd);
            }
            right.normalize();
            const realUp = new Vec3().cross(fwd, right).normalize();
            const m = [
                [right.x, realUp.x, fwd.x],
                [right.y, realUp.y, fwd.y],
                [right.z, realUp.z, fwd.z]
            ];
            qStart = quatFromMat3(m);
        }

        // 目标旋转：优先使用该关键帧的原始旋转（经 flipXY 转至 PlayCanvas），否则由 position->target 构造
        let qEnd: QuatT | null = null;
        const rawRotEnd = frameRawRotMap.get(endFrame);
        if (rawRotEnd) {
            const mEnd = flipXYRotation(rawRotEnd);
            if (mEnd) qEnd = quatFromMat3(mEnd);
        }
        if (!qEnd) {
            const fwd = nearest.target.clone().sub(nearest.position).normalize();
            const up = new Vec3(0, 1, 0);
            let right = new Vec3().cross(up, fwd);
            if (right.length() < 1e-4) { up.set(0, 0, 1); right = new Vec3().cross(up, fwd); }
            right.normalize();
            const realUp = new Vec3().cross(fwd, right).normalize();
            const m = [
                [right.x, realUp.x, fwd.x],
                [right.y, realUp.y, fwd.y],
                [right.z, realUp.z, fwd.z]
            ];
            qEnd = quatFromMat3(m);
        }

        let elapsed = 0;
        let acc = 0;

    jumpInProgress = true;
    jumpAnimHandle = events.on('update', (dt: number) => {
            elapsed += dt;
            acc += dt;

            // 按固定步长推进，确保约 60fps 的插值采样
            let advanced = false;
            while (acc >= fixedStep) {
                acc -= fixedStep;
                advanced = true;
                const t = Math.min(1, elapsed / durationSec);

                // 推进并同步时间轴帧
                const lerpFrameF = startFrame + frameDelta * t;
                const currFrame = Math.round(lerpFrameF);
                events.fire('timeline.setFrame', currFrame);

                // 手动插值相机姿态：位置线性，旋转四元数球面插值
                const pos = startPos.clone();
                pos.lerp(startPos, nearest!.position, t);

                let rotMat: number[][] | null = null;
                if (qStart && qEnd) {
                    const qi = quatSlerp(qStart, qEnd, t);
                    rotMat = mat3FromQuat(qi);
                }

                if (rotMat) {
                    events.fire('camera.setView', {
                        position: pos,
                        rotation: rotMat,
                        speed: 0
                    });
                } else {
                    // fallback：无旋转信息时仅移动位置
                    events.fire('camera.setPose', { position: pos, target: nearest!.target }, 0);
                }

                if (t >= 1) {
                    // 结束：对齐到精确目标并将时间轴停在关键帧
                    events.fire('timeline.setFrame', endFrame);
                    // 终态应用：使用目标旋转矩阵（若可得）
                    let finalMat: number[][] | null = null;
                    if (rawRotEnd) {
                        finalMat = flipXYRotation(rawRotEnd);
                    }
                    if (!finalMat && qEnd) finalMat = mat3FromQuat(qEnd);
                    if (finalMat) {
                        events.fire('camera.setView', {
                            position: nearest!.position,
                            rotation: finalMat,
                            speed: 0
                        });
                    } else {
                        events.fire('camera.setPose', { position: nearest!.position, target: nearest!.target }, 0);
                    }
                    jumpAnimHandle!.off();
                    jumpAnimHandle = null;
                    jumpInProgress = false;
                    return;
                }
            }

            // 如果这一帧未达到固定步长，至少保持时间推进到目标时长
            if (!advanced && elapsed >= durationSec) {
                events.fire('timeline.setFrame', endFrame);
                let finalMat: number[][] | null = null;
                if (rawRotEnd) finalMat = flipXYRotation(rawRotEnd);
                if (!finalMat && qEnd) finalMat = mat3FromQuat(qEnd);
                if (finalMat) {
                    events.fire('camera.setView', { position: nearest!.position, rotation: finalMat, speed: 0 });
                } else {
                    events.fire('camera.setPose', { position: nearest!.position, target: nearest!.target }, 0);
                }
                jumpAnimHandle!.off();
                jumpAnimHandle = null;
                jumpInProgress = false;
            }
        });
    });
};

export { registerCameraPosesEvents, Pose };
