import {
    math,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    PIXELFORMAT_DEPTH,
    PROJECTION_ORTHOGRAPHIC,
    PROJECTION_PERSPECTIVE,
    TONEMAP_NONE,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_LINEAR,
    TONEMAP_NEUTRAL,
    BoundingBox,
    Entity,
    Picker,
    Plane,
    Ray,
    RenderTarget,
    Texture,
    Quat,
    Vec3,
    WebglGraphicsDevice
} from 'playcanvas';

import { PointerController } from './controllers';
import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { Splat } from './splat';
import { TweenValue } from './tween-value';

// calculate the forward vector given azimuth and elevation
const calcForwardVec = (result: Vec3, azim: number, elev: number) => {
    const ex = elev * math.DEG_TO_RAD;
    const ey = azim * math.DEG_TO_RAD;
    const s1 = Math.sin(-ex);
    const c1 = Math.cos(-ex);
    const s2 = Math.sin(-ey);
    const c2 = Math.cos(-ey);
    result.set(-c1 * s2, s1, c1 * c2);
};

// work globals
const forwardVec = new Vec3();
const cameraPosition = new Vec3();
const plane = new Plane();
const ray = new Ray();
const vec = new Vec3();
const vecb = new Vec3();
const va = new Vec3();

// modulo dealing with negative numbers
const mod = (n: number, m: number) => ((n % m) + m) % m;

class Camera extends Element {
    controller: PointerController;
    entity: Entity;
    focalPointTween = new TweenValue({ x: 0, y: 0.5, z: 0 });
    azimElevTween = new TweenValue({ azim: 30, elev: -15 });
    distanceTween = new TweenValue({ distance: 1 });
    // roll angle (degrees) to preserve in-plane rotation
    rollTween = new TweenValue({ roll: 0 });
    // free-orientation mode (timeline)
    freeMode = false;
    freePosTween = new TweenValue({ x: 0, y: 0, z: 0 });
    freeRot = new Quat();
    freeRotTarget = new Quat();
    // orbit orientation driven by quaternion (no azim/elev/roll in render path)
    orbitRot = new Quat();
    orbitRotTarget = new Quat();

    minElev = -90;
    maxElev = 90;

    sceneRadius = 1;

    flySpeed = 5;

    // yaw-only rotation flag (horizontal-only when true)
    yawOnly = true;

    picker: Picker;

    workRenderTarget: RenderTarget;

    // overridden target size
    targetSize: { width: number, height: number } = null;

    suppressFinalBlit = false;

    renderOverlays = true;

    updateCameraUniforms: () => void;

    constructor() {
        super(ElementType.camera);
        // create the camera entity
        this.entity = new Entity('Camera');
        this.entity.addComponent('camera');

        // NOTE: this call is needed for refraction effect to work correctly, but
        // it slows rendering and should only be made when required.
        // this.entity.camera.requestSceneColorMap(true);
    }

    // ortho
    set ortho(value: boolean) {
        if (value !== this.ortho) {
            this.entity.camera.projection = value ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE;
            this.scene.events.fire('camera.ortho', value);
        }
    }

    get ortho() {
        return this.entity.camera.projection === PROJECTION_ORTHOGRAPHIC;
    }

    // fov
    set fov(value: number) {
        this.entity.camera.fov = value;
    }

    get fov() {
        return this.entity.camera.fov;
    }

    // tonemapping
    set tonemapping(value: string) {
        const mapping: Record<string, number> = {
            none: TONEMAP_NONE,
            linear: TONEMAP_LINEAR,
            neutral: TONEMAP_NEUTRAL,
            aces: TONEMAP_ACES,
            aces2: TONEMAP_ACES2,
            filmic: TONEMAP_FILMIC,
            hejl: TONEMAP_HEJL
        };

        const tvalue = mapping[value];

        if (tvalue !== undefined && tvalue !== this.entity.camera.toneMapping) {
            this.entity.camera.toneMapping = tvalue;
            this.scene.events.fire('camera.tonemapping', value);
        }
    }

    get tonemapping() {
        switch (this.entity.camera.toneMapping) {
            case TONEMAP_NONE: return 'none';
            case TONEMAP_LINEAR: return 'linear';
            case TONEMAP_NEUTRAL: return 'neutral';
            case TONEMAP_ACES: return 'aces';
            case TONEMAP_ACES2: return 'aces2';
            case TONEMAP_FILMIC: return 'filmic';
            case TONEMAP_HEJL: return 'hejl';
        }
        return 'none';
    }

    // near clip
    set near(value: number) {
        this.entity.camera.nearClip = value;
    }

    get near() {
        return this.entity.camera.nearClip;
    }

    // far clip
    set far(value: number) {
        this.entity.camera.farClip = value;
    }

    get far() {
        return this.entity.camera.farClip;
    }

    // focal point
    get focalPoint() {
        const t = this.focalPointTween.target;
        return new Vec3(t.x, t.y, t.z);
    }

    // azimuth, elevation
    get azimElev() {
        return this.azimElevTween.target;
    }

    get azim() {
        return this.azimElev.azim;
    }

    get elevation() {
        return this.azimElev.elev;
    }

    get distance() {
        return this.distanceTween.target.distance;
    }

    setFocalPoint(point: Vec3, dampingFactorFactor: number = 1) {
        this.focalPointTween.goto(point, dampingFactorFactor * this.scene.config.controls.dampingFactor);
    }

    setAzimElev(azim: number, elev: number, dampingFactorFactor: number = 1) {
        // manual orbit uses quaternion; azim/elev kept for UI only
        this.freeMode = false;
        // clamp UI values
        azim = mod(azim, 360);
        elev = Math.max(this.minElev, Math.min(this.maxElev, elev));

        // update UI tween (no effect on rendering)
        const t = this.azimElevTween;
        t.goto({ azim, elev }, dampingFactorFactor * this.scene.config.controls.dampingFactor);
        if (t.source.azim - azim < -180) t.source.azim += 360; else if (t.source.azim - azim > 180) t.source.azim -= 360;

        // build orbit orientation from yaw(azim), pitch(elev) with zero roll
        const qYaw = new Quat().setFromEulerAngles(0, azim, 0);
        const qPitch = new Quat().setFromEulerAngles(elev, 0, 0);
        // note: pitch then yaw in world gives expected orbit behavior
        this.orbitRot.mul2(qYaw, qPitch);

        this.ortho = false;
    }

    setDistance(distance: number, dampingFactorFactor: number = 1) {
        const controls = this.scene.config.controls;

        // clamp
        distance = Math.max(controls.minZoom, Math.min(controls.maxZoom, distance));

        const t = this.distanceTween;
        t.goto({ distance }, dampingFactorFactor * controls.dampingFactor);
    }

    setPose(position: Vec3, target: Vec3, dampingFactorFactor: number = 1) {
    // setPose uses orbit model -> exit free mode
    this.freeMode = false;
        vec.sub2(target, position);
        const l = vec.length();
        const azim = Math.atan2(-vec.x / l, -vec.z / l) * math.RAD_TO_DEG;
        const elev = Math.asin(vec.y / l) * math.RAD_TO_DEG;
        this.setFocalPoint(target, dampingFactorFactor);
        this.setAzimElev(azim, elev, dampingFactorFactor);
        this.setDistance(l / this.sceneRadius * this.fovFactor, dampingFactorFactor);
    }

    // set roll kept for compatibility (UI), not used to render in orbit path
    setRoll(roll: number, dampingFactorFactor: number = 1) {
        const controls = this.scene.config.controls;
        let r = ((roll % 360) + 360) % 360;
        if (r >= 180) r -= 360;
        this.rollTween.goto({ roll: r }, dampingFactorFactor * controls.dampingFactor);
    }

    // Set camera view using world-space position, rotation and focal lengths (fx, fy).
    // Free mode: directly apply position + quaternion; orbit-only when user manipulates.
    setView(position: Vec3, rotation: number[] | number[][], fx?: number, fy?: number, dampingFactorFactor?: number): void {
        const damping = typeof dampingFactorFactor === 'number' ? dampingFactorFactor : 1;

        // enter free mode (timeline)
        this.freeMode = true;

        // previous world distance for target derivation / ortho height
        const prevWorldDistance = this.distanceTween.value.distance * this.sceneRadius / this.fovFactor;

        // extract basis vectors from rotation (columns): right=X, up=Y, forward=Z
        const col = (rot: number[] | number[][] | null, i: number): Vec3 | null => {
            if (!rot) return null;
            if (Array.isArray(rot) && (rot as any).length === 3 && Array.isArray((rot as any)[0])) {
                const m = rot as number[][];
                return new Vec3(m[0][i], m[1][i], m[2][i]);
            }
            if (Array.isArray(rot) && (rot as any).length === 9) {
                const f = rot as number[];
                return new Vec3(f[0 + i], f[3 + i], f[6 + i]);
            }
            return null;
        };

        const right = col(rotation, 0) ?? new Vec3(1, 0, 0);
        const up = col(rotation, 1) ?? new Vec3(0, 1, 0);
        const forward = col(rotation, 2) ?? new Vec3(0, 0, 1);
        if (right.length() > 1e-6) right.normalize();
        if (up.length() > 1e-6) up.normalize();
        if (forward.length() > 1e-6) forward.normalize();

        // update FOV from fx/fy if provided
        if (typeof fx === 'number' && typeof fy === 'number' && fx > 1e-6 && fy > 1e-6) {
            const { width, height } = this.scene.targetSize;
            if (width > 0 && height > 0) {
                const fovX = 2 * Math.atan(width / (2 * fx)) * math.RAD_TO_DEG;
                const fovY = 2 * Math.atan(height / (2 * fy)) * math.RAD_TO_DEG;
                this.fov = this.entity.camera.horizontalFov ? fovX : fovY;
            }
        }

        // maintain focal point and distance for clipping / ortho calculations: forward is camera forward; orbit uses backward vector
        // pos = FP + (-forward) * d  =>  FP = pos + forward * d
        const desiredTarget = position.clone().add(forward.clone().mulScalar(prevWorldDistance));
        this.setFocalPoint(desiredTarget, damping);
        this.setDistance(prevWorldDistance / this.sceneRadius * this.fovFactor, damping);

        // build quaternion from adjusted basis so that entity.forward (=-Z) matches camera forward.
        // Use columns [right, -up, -forward] to keep det=+1 and align forward sign.
        const r0 = right.clone();
        const u0 = up.clone().mulScalar(-1);
        const f0 = forward.clone().mulScalar(-1);
        const m00 = r0.x, m01 = u0.x, m02 = f0.x;
        const m10 = r0.y, m11 = u0.y, m12 = f0.y;
        const m20 = r0.z, m21 = u0.z, m22 = f0.z;
        const tr = m00 + m11 + m22;
        let qx: number, qy: number, qz: number, qw: number;
        if (tr > 0) {
            const s = Math.sqrt(tr + 1.0) * 2;
            qw = 0.25 * s;
            qx = (m21 - m12) / s;
            qy = (m02 - m20) / s;
            qz = (m10 - m01) / s;
        } else if (m00 > m11 && m00 > m22) {
            const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
            qw = (m21 - m12) / s;
            qx = 0.25 * s;
            qy = (m01 + m10) / s;
            qz = (m02 + m20) / s;
        } else if (m11 > m22) {
            const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
            qw = (m02 - m20) / s;
            qx = (m01 + m10) / s;
            qy = 0.25 * s;
            qz = (m12 + m21) / s;
        } else {
            const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
            qw = (m10 - m01) / s;
            qx = (m02 + m20) / s;
            qy = (m12 + m21) / s;
            qz = 0.25 * s;
        }
        const invLen = 1 / Math.hypot(qx, qy, qz, qw);
        this.freeRotTarget.set(qx * invLen, qy * invLen, qz * invLen, qw * invLen);

        // tween position and apply rotation
        this.freePosTween.goto(position, damping * this.scene.config.controls.dampingFactor);
        this.freeRot.copy(this.freeRotTarget);
    }

    // convert world to screen coordinate
    worldToScreen(world: Vec3, screen: Vec3) {
        this.entity.camera.worldToScreen(world, screen);
    }

    add() {
        this.scene.cameraRoot.addChild(this.entity);
        this.entity.camera.layers = this.entity.camera.layers.concat([
            this.scene.shadowLayer.id,
            this.scene.debugLayer.id,
            this.scene.gizmoLayer.id
        ]);

        if (this.scene.config.camera.debugRender) {
            this.entity.camera.setShaderPass(`debug_${this.scene.config.camera.debugRender}`);
        }

        const target = document.getElementById('canvas-container');

        this.controller = new PointerController(this, target);

        // apply scene config
        const config = this.scene.config;
        const controls = config.controls;

        // configure background
        this.entity.camera.clearColor.set(0, 0, 0, 0);

        this.minElev = (controls.minPolarAngle * 180) / Math.PI - 90;
        this.maxElev = (controls.maxPolarAngle * 180) / Math.PI - 90;

        // tonemapping
        this.scene.camera.entity.camera.toneMapping = {
            linear: TONEMAP_LINEAR,
            filmic: TONEMAP_FILMIC,
            hejl: TONEMAP_HEJL,
            aces: TONEMAP_ACES,
            aces2: TONEMAP_ACES2,
            neutral: TONEMAP_NEUTRAL
        }[config.camera.toneMapping];

        // exposure
        this.scene.app.scene.exposure = config.camera.exposure;

        this.fov = config.camera.fov;

        // initial camera position and orientation
        this.setAzimElev(controls.initialAzim, controls.initialElev, 0);
        this.setDistance(controls.initialZoom, 0);

        // picker
        const { width, height } = this.scene.targetSize;
        this.picker = new Picker(this.scene.app, width, height);

        // override buffer allocation to use our render target
        this.picker.allocateRenderTarget = () => { };
        this.picker.releaseRenderTarget = () => { };

        this.scene.events.on('scene.boundChanged', this.onBoundChanged, this);

        // prepare camera-specific uniforms
        this.updateCameraUniforms = () => {
            const device = this.scene.graphicsDevice;
            const entity = this.entity;
            const camera = entity.camera;

            const set = (name: string, vec: Vec3) => {
                device.scope.resolve(name).setValue([vec.x, vec.y, vec.z]);
            };

            // get frustum corners in world space
            const points = camera.camera.getFrustumCorners(-100);
            const worldTransform = entity.getWorldTransform();
            for (let i = 0; i < points.length; i++) {
                worldTransform.transformPoint(points[i], points[i]);
            }

            // near
            if (camera.projection === PROJECTION_PERSPECTIVE) {
                // perspective
                set('near_origin', worldTransform.getTranslation());
                set('near_x', Vec3.ZERO);
                set('near_y', Vec3.ZERO);
            } else {
                // orthographic
                set('near_origin', points[3]);
                set('near_x', va.sub2(points[0], points[3]));
                set('near_y', va.sub2(points[2], points[3]));
            }

            // far
            set('far_origin', points[7]);
            set('far_x', va.sub2(points[4], points[7]));
            set('far_y', va.sub2(points[6], points[7]));
        };
    }

    remove() {
        this.controller.destroy();
        this.controller = null;

        this.entity.camera.layers = this.entity.camera.layers.filter(layer => layer !== this.scene.shadowLayer.id);
        this.scene.cameraRoot.removeChild(this.entity);

        // destroy doesn't exist on picker?
        // this.picker.destroy();
        this.picker = null;

        this.scene.events.off('scene.boundChanged', this.onBoundChanged, this);
    }

    // handle the scene's bound changing. the camera must be configured to render
    // the entire extents as well as possible.
    // also update the existing camera distance to maintain the current view
    onBoundChanged(bound: BoundingBox) {
        const prevDistance = this.distanceTween.value.distance * this.sceneRadius;
        this.sceneRadius = Math.max(1e-03, bound.halfExtents.length());
        this.setDistance(prevDistance / this.sceneRadius, 0);
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(
            this.fov,
            this.tonemapping,
            this.entity.camera.renderTarget?.width,
            this.entity.camera.renderTarget?.height
        );
    }

    // handle the viewer canvas resizing
    rebuildRenderTargets() {
        const device = this.scene.graphicsDevice;
        const { width, height } = this.targetSize ?? this.scene.targetSize;

        const rt = this.entity.camera.renderTarget;
        if (rt && rt.width === width && rt.height === height) {
            return;
        }

        // out with the old
        if (rt) {
            rt.destroyTextureBuffers();
            rt.destroy();

            this.workRenderTarget.destroy();
            this.workRenderTarget = null;
        }

        const createTexture = (name: string, width: number, height: number, format: number) => {
            return new Texture(device, {
                name,
                width,
                height,
                format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // in with the new
        const colorBuffer = createTexture('cameraColor', width, height, PIXELFORMAT_RGBA8);
        const depthBuffer = createTexture('cameraDepth', width, height, PIXELFORMAT_DEPTH);
        const renderTarget = new RenderTarget({
            colorBuffer,
            depthBuffer,
            flipY: false,
            autoResolve: false
        });
        this.entity.camera.renderTarget = renderTarget;
        this.entity.camera.horizontalFov = width > height;

        const workColorBuffer = createTexture('workColor', width, height, PIXELFORMAT_RGBA8);

        // create pick mode render target (reuse color buffer)
        this.workRenderTarget = new RenderTarget({
            colorBuffer: workColorBuffer,
            depth: false,
            autoResolve: false
        });

        // set picker render target
        (this.picker as any).renderTarget = this.workRenderTarget;

        this.scene.events.fire('camera.resize', { width, height });
    }

    onUpdate(deltaTime: number) {
        // controller update
        this.controller.update(deltaTime);

        // update underlying values
        this.focalPointTween.update(deltaTime);
        this.azimElevTween.update(deltaTime);
        this.distanceTween.update(deltaTime);
        this.rollTween.update(deltaTime);
        this.freePosTween.update(deltaTime);

        const azimElev = this.azimElevTween.value;
        const distance = this.distanceTween.value;

        if (this.freeMode) {
            // free mode: direct position + quaternion
            this.entity.setLocalPosition(new Vec3(this.freePosTween.value.x, this.freePosTween.value.y, this.freePosTween.value.z));
            this.entity.setLocalRotation(this.freeRot);
        } else {
            // orbit mode (quaternion-driven)
            // derive forward from orbitRot
            const qx = this.orbitRot.x, qy = this.orbitRot.y, qz = this.orbitRot.z, qw = this.orbitRot.w;
            const xx = qx * qx, yy = qy * qy, zz = qz * qz;
            const xy = qx * qy, xz = qx * qz, yz = qy * qz;
            const wx = qw * qx, wy = qw * qy, wz = qw * qz;
            // camera forward (local -Z in world)
            forwardVec.set(
                2 * (xz + wy),
                2 * (yz - wx),
                1 - 2 * (xx + yy)
            );
            if (forwardVec.length() > 1e-6) forwardVec.normalize();

            const worldDist = distance.distance * this.sceneRadius / this.fovFactor;
            cameraPosition.copy(this.focalPointTween.value);
            // pos = FP - forward * d
            cameraPosition.sub(forwardVec.clone().mulScalar(worldDist));

            this.entity.setLocalPosition(cameraPosition);
            this.entity.setLocalRotation(this.orbitRot);
        }

        this.fitClippingPlanes(this.entity.getLocalPosition(), this.entity.forward);

        const { camera } = this.entity;
        camera.orthoHeight = this.distanceTween.value.distance * this.sceneRadius / this.fovFactor * (this.fov / 90) * (camera.horizontalFov ? this.scene.targetSize.height / this.scene.targetSize.width : 1);
        camera.camera._updateViewProjMat();
    }

    fitClippingPlanes(cameraPosition: Vec3, forwardVec: Vec3) {
        const bound = this.scene.bound;
        const boundRadius = bound.halfExtents.length();

        vec.sub2(bound.center, cameraPosition);
        const dist = vec.dot(forwardVec);

        if (dist > 0) {
            this.far = dist + boundRadius;
            // if camera is placed inside the sphere bound calculate near based far
            this.near = Math.max(1e-6, dist < boundRadius ? this.far / (1024 * 16) : dist - boundRadius);
        } else {
            // if the scene is behind the camera
            this.far = boundRadius * 2;
            this.near = this.far / (1024 * 16);
        }
    }

    onPreRender() {
        this.rebuildRenderTargets();
        this.updateCameraUniforms();
    }

    onPostRender() {
        const device = this.scene.graphicsDevice as WebglGraphicsDevice;
        const renderTarget = this.entity.camera.renderTarget;

        // resolve msaa buffer
        if (renderTarget.samples > 1) {
            renderTarget.resolve(true, false);
        }

        // copy render target
        if (!this.suppressFinalBlit) {
            device.copyRenderTarget(renderTarget, null, true, false);
        }
    }

    focus(options?: { focalPoint: Vec3, radius: number, speed: number }) {
        const getSplatFocalPoint = () => {
            for (const element of this.scene.elements) {
                if (element.type === ElementType.splat) {
                    const focalPoint = (element as Splat).focalPoint?.();
                    if (focalPoint) {
                        return focalPoint;
                    }
                }
            }
        };

        const focalPoint = options ? options.focalPoint : (getSplatFocalPoint() ?? this.scene.bound.center);
        const focalRadius = options ? options.radius : this.scene.bound.halfExtents.length();

        const fdist = focalRadius / this.sceneRadius;

        this.setDistance(isFinite(fdist) ? fdist : 1, options?.speed ?? 0);
        this.setFocalPoint(focalPoint, options?.speed ?? 0);
    }

    get fovFactor() {
        // we set the fov of the longer axis. here we get the fov of the other (smaller) axis so framing
        // doesn't cut off the scene.
        const { width, height } = this.scene.targetSize;
        const aspect = (width && height) ? this.entity.camera.horizontalFov ? height / width : width / height : 1;
        const fov = 2 * Math.atan(Math.tan(this.fov * math.DEG_TO_RAD * 0.5) * aspect);
        return Math.sin(fov * 0.5);
    }

    // intersect the scene at the given screen coordinate and focus the camera on this location
    pickFocalPoint(screenX: number, screenY: number) {
        const scene = this.scene;
        const cameraPos = this.entity.getPosition();

        const target = scene.canvas;
        const sx = screenX / target.clientWidth * scene.targetSize.width;
        const sy = screenY / target.clientHeight * scene.targetSize.height;

        const splats = scene.getElementsByType(ElementType.splat);

        let closestD = 0;
        const closestP = new Vec3();
        let closestSplat = null;

        for (let i = 0; i < splats.length; ++i) {
            const splat = splats[i] as Splat;

            this.pickPrep(splat, 'set');
            const pickId = this.pick(sx, sy);

            if (pickId !== -1) {
                splat.calcSplatWorldPosition(pickId, vec);

                // create a plane at the world position facing perpendicular to the camera
                plane.setFromPointNormal(vec, this.entity.forward);

                // create the pick ray in world space
                if (this.ortho) {
                    this.entity.camera.screenToWorld(screenX, screenY, -1.0, vec);
                    this.entity.camera.screenToWorld(screenX, screenY, 1.0, vecb);
                    vecb.sub(vec).normalize();
                    ray.set(vec, vecb);
                } else {
                    this.entity.camera.screenToWorld(screenX, screenY, 1.0, vec);
                    vec.sub(cameraPos).normalize();
                    ray.set(cameraPos, vec);
                }

                // find intersection
                if (plane.intersectsRay(ray, vec)) {
                    const distance = vecb.sub2(vec, ray.origin).length();
                    if (!closestSplat || distance < closestD) {
                        closestD = distance;
                        closestP.copy(vec);
                        closestSplat = splat;
                    }
                }
            }
        }

        if (closestSplat) {
            this.setFocalPoint(closestP);
            this.setDistance(closestD / this.sceneRadius * this.fovFactor);
            scene.events.fire('camera.focalPointPicked', {
                camera: this,
                splat: closestSplat,
                position: closestP
            });
        }
    }

    // pick mode

    // render picker contents
    pickPrep(splat: Splat, op: 'add'|'remove'|'set') {
        const { width, height } = this.scene.targetSize;
        const worldLayer = this.scene.app.scene.layers.getLayerByName('World');

        const device = this.scene.graphicsDevice;
        const events = this.scene.events;
        const alpha = events.invoke('camera.mode') === 'rings' ? 0.0 : 0.2;

        // hide non-selected elements
        const splats = this.scene.getElementsByType(ElementType.splat);
        splats.forEach((s: Splat) => {
            s.entity.enabled = s === splat;
        });

        device.scope.resolve('pickerAlpha').setValue(alpha);
        device.scope.resolve('pickMode').setValue(['add', 'remove', 'set'].indexOf(op));
        this.picker.resize(width, height);
        this.picker.prepare(this.entity.camera, this.scene.app.scene, [worldLayer]);

        // re-enable all splats
        splats.forEach((splat: Splat) => {
            splat.entity.enabled = true;
        });
    }

    pick(x: number, y: number) {
        return this.pickRect(x, y, 1, 1)[0];
    }

    pickRect(x: number, y: number, width: number, height: number) {
        const device = this.scene.graphicsDevice as WebglGraphicsDevice;
        const pixels = new Uint8Array(width * height * 4);

        // read pixels
        device.setRenderTarget((this.picker as any).renderTarget);
        device.updateBegin();
        device.readPixels(x, (this.picker as any).renderTarget.height - y - height, width, height, pixels);
        device.updateEnd();

        const result: number[] = [];
        for (let i = 0; i < width * height; i++) {
            result.push(
                pixels[i * 4] |
                (pixels[i * 4 + 1] << 8) |
                (pixels[i * 4 + 2] << 16) |
                (pixels[i * 4 + 3] << 24)
            );
        }

        return result;
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        return {
            focalPoint: pack3(this.focalPointTween.target),
            azim: this.azim,
            elev: this.elevation,
            distance: this.distance,
            fov: this.fov,
            tonemapping: this.tonemapping
        };
    }

    docDeserialize(settings: any) {
        this.setFocalPoint(new Vec3(settings.focalPoint), 0);
        this.setAzimElev(settings.azim, settings.elev, 0);
        this.setDistance(settings.distance, 0);
        this.fov = settings.fov;
        this.tonemapping = settings.tonemapping;
    }

    // offscreen render mode

    startOffscreenMode(width: number, height: number) {
        this.targetSize = { width, height };
        this.suppressFinalBlit = true;
    }

    endOffscreenMode() {
        this.targetSize = null;
        this.suppressFinalBlit = false;
    }

    // manual control should leave free mode; sync orbit params to current free pose to avoid jumps
    exitFreeMode() {
        if (!this.freeMode) return;

        // hand off orientation directly
        this.orbitRot.copy(this.freeRot);

        // synchronize focal point and distance so orbit computes identical position
        const posNow = new Vec3(this.freePosTween.value.x, this.freePosTween.value.y, this.freePosTween.value.z);
        const fpNow = this.focalPointTween.value.clone ? this.focalPointTween.value.clone() : new Vec3(this.focalPointTween.value.x, this.focalPointTween.value.y, this.focalPointTween.value.z);
        const offset = posNow.clone().sub(fpNow);
        const worldDist = Math.max(1e-6, offset.length());
        // compute camera forward from orbitRot
        const qx = this.orbitRot.x, qy = this.orbitRot.y, qz = this.orbitRot.z, qw = this.orbitRot.w;
        const xx = qx * qx, yy = qy * qy, zz = qz * qz;
        const xy = qx * qy, xz = qx * qz, yz = qy * qz;
        const wx = qw * qx, wy = qw * qy, wz = qw * qz;
        const fwd = new Vec3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy));
        if (fwd.length() > 1e-6) fwd.normalize();
        const newFocal = posNow.clone().add(fwd.clone().mulScalar(worldDist));
        this.setFocalPoint(newFocal, 0);
        this.setDistance(worldDist / this.sceneRadius * this.fovFactor, 0);

        // optionally mirror UI angles (no damping)
        const l = Math.max(1e-6, fwd.length());
        const azim = Math.atan2(-fwd.x / l, -fwd.z / l) * math.RAD_TO_DEG;
        const elev = Math.asin(fwd.y / l) * math.RAD_TO_DEG;
        this.azimElevTween.goto({ azim, elev }, 0);

        this.freeMode = false;
    }

    // unified movement for keyboard input in free camera mode
    // x: strafe right/left, y: world up/down, z: forward/backward (flattened to keep world up)
    moveByInput(x: number, y: number, z: number, factor: number) {
        // ensure we are in free camera mode; convert from orbit if needed
        if (!this.freeMode) {
            this.enterFreeFromOrbit();
        }

        const worldTransform = this.entity.getWorldTransform();

        // basis vectors in world space
        const right = worldTransform.getX().clone();
        const forward = worldTransform.getZ().clone();

        // remove world-up (Z) component so WASD moves stay in horizontal plane (X-Y plane)
        right.z = 0;
        forward.z = 0;

        if (right.length() > 1e-6) right.normalize();
        if (forward.length() > 1e-6) forward.normalize();

        const dx = right.mulScalar(x * factor);
        const df = forward.mulScalar(y * factor);
        const du = new Vec3(0, 0, z * factor); // vertical movement applied to Z
        const delta = dx.add(df).add(du);

        // move the free camera position directly
        const pos = new Vec3(this.freePosTween.value.x, this.freePosTween.value.y, this.freePosTween.value.z);
        pos.add(delta);
        this.freePosTween.goto(pos, this.scene.config.controls.dampingFactor);
    }

    // world-space translation used by remote controller (phone displacement)
    moveByWorldDelta(delta: Vec3) {
        if (!this.freeMode) {
            this.enterFreeFromOrbit();
        }

        if (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9 && Math.abs(delta.z) < 1e-9) {
            return;
        }

        const pos = new Vec3(this.freePosTween.value.x, this.freePosTween.value.y, this.freePosTween.value.z);
        pos.add(delta);
        this.freePosTween.goto(pos, 0);

        const focal = this.focalPoint.clone().add(delta);
        this.focalPointTween.goto(focal, 0);
    }

    // Convert current orbit pose to free pose (no snap)
    enterFreeFromOrbit() {
        if (this.freeMode) return;

        // compute current orbit world position
        const worldDist = this.distanceTween.value.distance * this.sceneRadius / this.fovFactor;
        // forward from orbitRot (camera forward)
        const qx = this.orbitRot.x, qy = this.orbitRot.y, qz = this.orbitRot.z, qw = this.orbitRot.w;
        const xx = qx * qx, yy = qy * qy, zz = qz * qz;
        const xy = qx * qy, xz = qx * qz, yz = qy * qz;
        const wx = qw * qx, wy = qw * qy, wz = qw * qz;
        forwardVec.set(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy));
        if (forwardVec.length() > 1e-6) forwardVec.normalize();

        const pos = this.focalPoint.clone().sub(forwardVec.clone().mulScalar(worldDist));
        this.freePosTween.goto(pos, 0);
        this.freeRot.copy(this.orbitRot);
        this.freeMode = true;
    }

    // Free-look rotation driven by mouse deltas (degrees scaled by sensitivity)
    rotateFree(dx: number, dy: number) {
        // ensure free mode using current orbit pose
        if (!this.freeMode) this.enterFreeFromOrbit();

        const sens = this.scene.config.controls.orbitSensitivity;
        const yawDeg = -dx * sens;   // drag right -> yaw right
        const pitchDeg = -dy * sens; // drag up -> look up

        // world-up yaw: for Z-up, yaw is rotation about Z axis
        const qYaw = new Quat().setFromEulerAngles(0, 0, yawDeg);

        if (this.yawOnly) {
            // horizontal-only mode: ignore pitch
            this.freeRot.mul2(qYaw, this.freeRot);
            return;
        }

        // local-right pitch: build axis from current freeRot
        const qx = this.freeRot.x, qy = this.freeRot.y, qz = this.freeRot.z, qw = this.freeRot.w;
        const xx = qx * qx, yy = qy * qy, zz = qz * qz;
        const xy = qx * qy, xz = qx * qz, yz = qy * qz;
        const wx = qw * qx, wy = qw * qy, wz = qw * qz;
        const right = new Vec3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy));
        if (right.length() > 1e-6) right.normalize();
        const qPitch = new Quat().setFromAxisAngle(right, pitchDeg);

        // apply yaw (world) then pitch (local)
        this.freeRot.mul2(qYaw, this.freeRot);
        this.freeRot.mul2(qPitch, this.freeRot);
    }
}

export { Camera };
