import { Color, Vec3 } from 'playcanvas';

import { Element, ElementType } from './element';
import { Events } from './events';

type CameraRaw = any;

class CameraFrustums extends Element {
    events: Events;
    cameras: CameraRaw[] = [];

    constructor(events: Events) {
        super(ElementType.debug);
        this.events = events;
        this.cameras = [];
        this.visible = false;
    }

    add() {
        // listen for loaded camera arrays
        this.events.on('camera.posesLoaded', (cameras: CameraRaw[]) => {
            if (!Array.isArray(cameras)) return;
            this.cameras = cameras.slice();
        });
        // listen for visibility toggle
        this.events.on('camera.frustumVisible', (value: boolean) => {
            this.visible = !!value;
        });
        // also clear when scene cleared
        this.events.on('scene.clearing', () => {
            this.cameras = [];
        });
    }

    onPreRender() {
        if (!this.visible) return;
        const app = this.scene.app;
        if (!this.cameras || this.cameras.length === 0) return;

        // draw a frustum for each camera using position+target or rotation
        const worldUp = new Vec3(0, 1, 0);
        const color = new Color(0.0, 1.0, 0.0);

        for (let i = 0; i < this.cameras.length; i++) {
            const cam = this.cameras[i];
            if (!cam || !cam.position || cam.position.length < 3) continue;

            const pos = new Vec3(cam.position[0], cam.position[1], cam.position[2]);
            // use target if provided (already in same coord conv as loader), else try rotation->forward
            let target: Vec3 | null = null;
            if (cam.target && Array.isArray(cam.target) && cam.target.length >= 3) {
                target = new Vec3(cam.target[0], cam.target[1], cam.target[2]);
            } else if (cam.rotation) {
                // try to extract third column as forward
                try {
                    const r = cam.rotation;
                    let fwd: Vec3 | null = null;
                    if (Array.isArray(r) && r.length === 3 && Array.isArray(r[0])) {
                        fwd = new Vec3(r[0][2], r[1][2], r[2][2]);
                    } else if (Array.isArray(r) && r.length === 9) {
                        fwd = new Vec3(r[2], r[5], r[8]);
                    }
                    if (fwd) {
                        const toCenter = fwd.clone();
                        target = pos.clone().add(toCenter);
                    }
                } catch (e) { /* noop */ }
            }

            // fallback target: look towards origin
            if (!target) target = new Vec3(0, 0, 0);

            // compute basis
            const forward = target.clone().sub(pos);
            if (forward.lengthSq() < 1e-8) continue;
            forward.normalize();
            let right = new Vec3().cross(forward, worldUp);
            if (right.lengthSq() < 1e-6) {
                // degenerate: pick an alternate up
                right = new Vec3().cross(forward, new Vec3(0, 0, 1));
            }
            right.normalize();
            const up = new Vec3().cross(right, forward).normalize();

            // frustum scale: use distance to target
            const dist = Math.max(1e-3, pos.distance(target));
            // fov: prefer fx/fy if present to compute angle, otherwise default
            let fovY = 40 * Math.PI / 180; // radians
            try {
                const intr = (cam.intrinsics || {});
                const fx = (typeof cam.fx === 'number') ? cam.fx : (typeof intr.fx === 'number' ? intr.fx : undefined);
                const fy = (typeof cam.fy === 'number') ? cam.fy : (typeof intr.fy === 'number' ? intr.fy : undefined);
                const ts = this.events.invoke('targetSize') as { width: number, height: number } | undefined;
                const width = ts?.width ?? 640;
                const height = ts?.height ?? 480;
                if (typeof fy === 'number' && fy > 0) {
                    fovY = 2 * Math.atan(height / (2 * fy));
                } else if (typeof fx === 'number' && fx > 0) {
                    const fovX = 2 * Math.atan(width / (2 * fx));
                    const aspect = width / Math.max(1, height);
                    fovY = 2 * Math.atan(Math.tan(fovX / 2) / aspect);
                } else {
                    // try to get current viewer fov
                    const camEnt = this.events.invoke('camera.entity');
                    if (camEnt && camEnt.camera && typeof camEnt.camera.fov === 'number') {
                        fovY = camEnt.camera.horizontalFov ? camEnt.camera.fov * Math.PI / 180 * (height / Math.max(1, width)) : camEnt.camera.fov * Math.PI / 180;
                    }
                }
            } catch (e) { /* noop */ }

            const depth = Math.max(0.25, dist * 0.35);
            const halfH = Math.tan(fovY / 2) * depth;
            const ts2 = this.events.invoke('targetSize') as { width: number, height: number } | undefined;
            const aspect2 = (ts2 && ts2.width && ts2.height) ? (ts2.width / ts2.height) : (16 / 9);
            const halfW = halfH * aspect2;

            const center = pos.clone().add(forward.clone().mulScalar(depth));

            const cx = right.clone().mulScalar(halfW);
            const cy = up.clone().mulScalar(halfH);

            const p0 = center.clone().add(cx).add(cy); // top-right
            const p1 = center.clone().sub(cx).add(cy); // top-left
            const p2 = center.clone().sub(cx).sub(cy); // bottom-left
            const p3 = center.clone().add(cx).sub(cy); // bottom-right

            // draw lines: pyramid from pos to corners and rectangle between corners
            try {
                app.drawLine(pos, p0, color);
                app.drawLine(pos, p1, color);
                app.drawLine(pos, p2, color);
                app.drawLine(pos, p3, color);

                app.drawLine(p0, p1, color);
                app.drawLine(p1, p2, color);
                app.drawLine(p2, p3, color);
                app.drawLine(p3, p0, color);
            } catch (e) {
                // if drawLine unavailable, silently ignore
            }
        }
    }
}

export { CameraFrustums };
