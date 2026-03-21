import { Button, Container, NumericInput, SelectInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Splat } from '../splat';
import { localize } from './localization';
import { Tooltips } from './tooltips';

class Ticks extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ticks'
        };

        super(args);

        const workArea = new Container({
            id: 'ticks-area'
        });

        this.append(workArea);

        let addKey: (value: number) => void;
        let removeKey: (index: number) => void;
        let frameFromOffset: (offset: number) => number;
        let moveCursor: (frame: number) => void;

        // rebuild the timeline
        const rebuild = () => {
            // clear existing labels
            workArea.dom.innerHTML = '';

            const numFrames = events.invoke('timeline.frames');
            const currentFrame = events.invoke('timeline.frame');

            const padding = 20;
            const width = this.dom.getBoundingClientRect().width - padding * 2;
            const labelStep = Math.max(1, Math.floor(numFrames / Math.max(1, Math.floor(width / 50))));
            const numLabels = Math.max(1, Math.ceil(numFrames / labelStep));

            const offsetFromFrame = (frame: number) => {
                return padding + Math.floor(frame / (numFrames - 1) * width);
            };

            frameFromOffset = (offset: number) => {
                return Math.max(0, Math.min(numFrames - 1, Math.floor((offset - padding) / width * (numFrames - 1))));
            };

            // timeline labels

            for (let i = 0; i < numLabels; i++) {
                const thisFrame = Math.floor(i * labelStep);
                const label = document.createElement('div');
                label.classList.add('time-label');
                label.style.left = `${offsetFromFrame(thisFrame)}px`;
                label.textContent = thisFrame.toString();
                workArea.dom.appendChild(label);
            }

            // keys

            const keys: HTMLElement[] = [];
            const createKey = (value: number) => {
                const label = document.createElement('div');
                label.classList.add('time-label', 'key');
                label.style.left = `${offsetFromFrame(value)}px`;
                workArea.dom.appendChild(label);
                keys.push(label);
            };

            (events.invoke('timeline.keys') as number[]).forEach(createKey);

            addKey = (value: number) => {
                createKey(value);
            };

            removeKey = (index: number) => {
                workArea.dom.removeChild(keys[index]);
                keys.splice(index, 1);
            };

            // cursor

            const cursor = document.createElement('div');
            cursor.classList.add('time-label', 'cursor');
            cursor.style.left = `${offsetFromFrame(currentFrame)}px`;
            cursor.textContent = currentFrame.toString();
            workArea.dom.appendChild(cursor);

            moveCursor = (frame: number) => {
                cursor.style.left = `${offsetFromFrame(frame)}px`;
                cursor.textContent = frame.toString();
            };
        };

        // handle scrubbing

        let scrubbing = false;

        workArea.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!scrubbing && event.isPrimary) {
                scrubbing = true;
                workArea.dom.setPointerCapture(event.pointerId);
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (scrubbing) {
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointerup', (event: PointerEvent) => {
            if (scrubbing && event.isPrimary) {
                workArea.dom.releasePointerCapture(event.pointerId);
                scrubbing = false;
            }
        });

        // rebuild the timeline on dom resize
        new ResizeObserver(() => rebuild()).observe(workArea.dom);

        // rebuild when timeline frames change
        events.on('timeline.frames', () => {
            rebuild();
        });

        // rebuild when selection changes to show different splat's keys
        events.on('timeline.selectionChanged', () => {
            rebuild();
        });

        // rebuild when a key's frame is updated (e.g., via simplify or move)
        events.on('timeline.keySet', () => {
            rebuild();
        });

        events.on('timeline.frame', (frame: number) => {
            moveCursor(frame);
        });

        events.on('timeline.keyAdded', (value: number) => {
            addKey(value);
        });

        events.on('timeline.keyRemoved', (index: number) => {
            removeKey(index);
        });
    }
}

class TimelinePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'timeline-panel'
        };

        super(args);

        // play controls

        const prev = new Button({
            class: 'button',
            text: '\uE162'
        });

        const play = new Button({
            class: 'button',
            text: '\uE131'
        });

        const next = new Button({
            class: 'button',
            text: '\uE164'
        });

        // key controls

        const addKey = new Button({
            class: 'button',
            text: '\uE120'
        });

        const removeKey = new Button({
            class: 'button',
            text: '\uE121',
            enabled: false
        });

        const loadKeys = new Button({
            class: 'button-json',
            text: 'JSON'
        });

        const simplifyToggle = new Button({
            class: 'button',
            text: 'SIM'
        });

        // jump-to-nearest-key pose button
        const jumpNearest = new Button({
            class: 'button',
            text: '\uE165', // use a navigation-like icon
            enabled: true
        });

        const uploadImages = new Button({
            class: 'button',
            text: 'IMG',
            enabled: true
        });

        const importCenter = new Button({
            class: 'button',
            text: 'CTR',
            enabled: true
        });

        const buttonControls = new Container({
            id: 'button-controls'
        });
        buttonControls.append(prev);
        buttonControls.append(play);
        buttonControls.append(next);
        buttonControls.append(addKey);
        buttonControls.append(removeKey);
        buttonControls.append(loadKeys);
        buttonControls.append(simplifyToggle);
        buttonControls.append(jumpNearest);
        buttonControls.append(uploadImages);
        buttonControls.append(importCenter);

        // settings

        const speed = new SelectInput({
            id: 'speed',
            defaultValue: 30,
            options: [
                { v: 1, t: '1 fps' },
                { v: 6, t: '6 fps' },
                { v: 12, t: '12 fps' },
                { v: 24, t: '24 fps' },
                { v: 30, t: '30 fps' },
                { v: 60, t: '60 fps' }
            ]
        });

        speed.on('change', (value: string) => {
            events.fire('timeline.setFrameRate', parseInt(value, 10));
        });

        events.on('timeline.frameRate', (frameRate: number) => {
            speed.value = frameRate.toString();
        });

        const frames = new NumericInput({
            id: 'totalFrames',
            value: 180,
            min: 1,
            max: 10000,
            precision: 0
        });

        frames.on('change', (value: number) => {
            events.fire('timeline.setFrames', value);
        });

        events.on('timeline.frames', (framesIn: number) => {
            frames.value = framesIn;
        });

        // smoothness

        const smoothness = new NumericInput({
            id: 'smoothness',
            min: 0,
            max: 1,
            step: 0.05,
            value: 1
        });

        smoothness.on('change', (value: number) => {
            events.fire('timeline.setSmoothness', value);
        });

        events.on('timeline.smoothness', (smoothnessIn: number) => {
            smoothness.value = smoothnessIn;
        });

        const settingsControls = new Container({
            id: 'settings-controls'
        });
        settingsControls.append(speed);
        settingsControls.append(frames);
        settingsControls.append(smoothness);

        // append control groups

        const controlsWrap = new Container({
            id: 'controls-wrap'
        });

        const spacerL = new Container({
            class: 'spacer'
        });

        const spacerR = new Container({
            class: 'spacer'
        });
        spacerR.append(settingsControls);

        controlsWrap.append(spacerL);
        controlsWrap.append(buttonControls);
        controlsWrap.append(spacerR);

        const ticks = new Ticks(events, tooltips);

        this.append(controlsWrap);
        this.append(ticks);

        // ui handlers

        const skip = (dir: 'forward' | 'back') => {
            const orderedKeys = (events.invoke('timeline.keys') as number[]).map((frame, index) => {
                return { frame, index };
            }).sort((a, b) => a.frame - b.frame);

            if (orderedKeys.length > 0) {
                const frame = events.invoke('timeline.frame');
                const nextKey = orderedKeys.findIndex(k => (dir === 'back' ? k.frame >= frame : k.frame > frame));
                const l = orderedKeys.length;

                if (nextKey === -1) {
                    events.fire('timeline.setFrame', orderedKeys[dir === 'back' ? l - 1 : 0].frame);
                } else {
                    events.fire('timeline.setFrame', orderedKeys[dir === 'back' ? (nextKey + l - 1) % l : nextKey].frame);
                }
            } else {
                // if there are no keys, just to start of timeline or end
                if (dir === 'back') {
                    events.fire('timeline.setFrame', 0);
                } else {
                    events.fire('timeline.setFrame', events.invoke('timeline.frames') - 1);
                }
            }
        };

        prev.on('click', () => {
            skip('back');
        });

        play.on('click', () => {
            if (events.invoke('timeline.playing')) {
                events.fire('timeline.setPlaying', false);
                play.text = '\uE131';
            } else {
                events.fire('timeline.setPlaying', true);
                play.text = '\uE135';
            }
        });

        next.on('click', () => {
            skip('forward');
        });

        addKey.on('click', () => {
            events.fire('timeline.add', events.invoke('timeline.frame'));
        });

        removeKey.on('click', () => {
            const index = events.invoke('timeline.keys').indexOf(events.invoke('timeline.frame'));
            if (index !== -1) {
                events.fire('timeline.remove', index);
            }
        });
        loadKeys.on('click', () => {
            events.fire('camera.loadKeys');
        });

        // Simplify toggle behavior
        const updateSimplifyLabel = () => {
            const on = !!events.invoke('camera.simplify.get');
            simplifyToggle.text = on ? 'SIM*' : 'SIM';
        };
        updateSimplifyLabel();
        simplifyToggle.on('click', () => {
            const curr = !!events.invoke('camera.simplify.get');
            events.fire('camera.simplify.set', !curr);
            updateSimplifyLabel();
        });

        uploadImages.on('click', () => {
            events.fire('images.uploadFolder');
        });

        importCenter.on('click', async () => {
            const splats = (events.invoke('scene.allSplats') as Splat[]) || [];
            if (splats.length === 0) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: '导入中心点失败',
                    message: '当前没有已加载的 Splat。'
                });
                return;
            }

            const target = await new Promise<Splat | null>((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.position = 'fixed';
                overlay.style.left = '0';
                overlay.style.top = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
                overlay.style.background = 'rgba(0,0,0,0.45)';
                overlay.style.display = 'flex';
                overlay.style.alignItems = 'center';
                overlay.style.justifyContent = 'center';
                overlay.style.zIndex = '10000';

                const panel = document.createElement('div');
                panel.style.width = '420px';
                panel.style.maxWidth = '92vw';
                panel.style.padding = '12px';
                panel.style.borderRadius = '10px';
                panel.style.background = 'rgba(30,34,41,0.98)';
                panel.style.border = '1px solid rgba(255,255,255,0.15)';
                panel.style.color = '#e8eef8';

                const title = document.createElement('div');
                title.textContent = '请选择要加载中心点的 Splat';
                title.style.fontWeight = '700';
                title.style.marginBottom = '8px';

                const select = document.createElement('select');
                select.style.width = '100%';
                select.style.padding = '8px';
                select.style.borderRadius = '8px';
                select.style.border = '1px solid rgba(255,255,255,0.2)';
                select.style.background = '#141820';
                select.style.color = '#eef6ff';

                splats.forEach((s, i) => {
                    const op = document.createElement('option');
                    op.value = String(i);
                    op.textContent = s.filename || s.name || `Splat ${i + 1}`;
                    select.appendChild(op);
                });

                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.justifyContent = 'flex-end';
                row.style.gap = '8px';
                row.style.marginTop = '10px';

                const cancelBtn = document.createElement('button');
                cancelBtn.textContent = '取消';
                const okBtn = document.createElement('button');
                okBtn.textContent = '确定';

                [cancelBtn, okBtn].forEach((btn) => {
                    btn.style.padding = '6px 12px';
                    btn.style.borderRadius = '8px';
                    btn.style.border = '1px solid rgba(255,255,255,0.2)';
                    btn.style.background = '#202734';
                    btn.style.color = '#eef6ff';
                    btn.style.cursor = 'pointer';
                });

                cancelBtn.onclick = () => {
                    overlay.remove();
                    resolve(null);
                };

                okBtn.onclick = () => {
                    const idx = Math.max(0, Math.min(splats.length - 1, parseInt(select.value, 10) || 0));
                    overlay.remove();
                    resolve(splats[idx] ?? null);
                };

                row.append(okBtn);
                row.append(cancelBtn);
                panel.append(title);
                panel.append(select);
                panel.append(row);
                overlay.append(panel);
                document.body.appendChild(overlay);
            });

            if (!target) {
                return;
            }

            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt,text/plain';
            input.style.display = 'none';

            input.onchange = async (event: Event) => {
                try {
                    const file = (event.target as HTMLInputElement).files?.[0];
                    if (!file) return;

                    const text = await file.text();
                    const nums = (text.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);

                    if (nums.length < 3 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1]) || !Number.isFinite(nums[2])) {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: '导入中心点失败',
                            message: 'txt 文件中未找到 3 个有效实数坐标。'
                        });
                        return;
                    }

                    // coordinate transform aligned with avg centroid convention
                    const center = new Vec3(nums[0], nums[1], nums[2]);
                    target.importedCenterLocal = center;
                    target.scene.forceRender = true;

                    await events.invoke('showPopup', {
                        type: 'info',
                        header: '导入中心点成功',
                        message: `目标: ${target.filename || target.name}\n中心点: [${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)}]`
                    });
                } catch (e) {
                    await events.invoke('showPopup', {
                        type: 'error',
                        header: '导入中心点失败',
                        message: `读取或解析 txt 失败: ${e}`
                    });
                } finally {
                    input.remove();
                }
            };

            document.body.appendChild(input);
            input.click();
        });

        jumpNearest.on('click', () => {
            events.fire('camera.jumpToNearestPose');
        });

        const canDelete = (frame: number) => events.invoke('timeline.keys').includes(frame);

        // 更新删除按钮状态的函数
        const updateRemoveKeyState = () => {
            const currentFrame = events.invoke('timeline.frame');
            removeKey.enabled = canDelete(currentFrame);
        };

        events.on('timeline.frame', (frame: number) => {
            updateRemoveKeyState();
        });

        events.on('timeline.keyRemoved', (index: number) => {
            updateRemoveKeyState();
        });

        events.on('timeline.keyAdded', (frame: number) => {
            updateRemoveKeyState();
        });

        // 当选择变化时，更新删除按钮状态
        events.on('timeline.selectionChanged', () => {
            updateRemoveKeyState();
        });

        // cancel animation playback if user interacts with camera
        events.on('camera.controller', (type: string) => {
            if (events.invoke('timeline.playing')) {
                // stop
            }
        });

        // tooltips
        tooltips.register(prev, '上一关键帧', 'top');
        tooltips.register(play, '播放/暂停', 'top');
        tooltips.register(next, '下一关键帧', 'top');
        tooltips.register(addKey, '添加关键帧', 'top');
        tooltips.register(removeKey, '删除关键帧', 'top');
        tooltips.register(loadKeys, '加载相机关键帧', 'top');
        tooltips.register(simplifyToggle, '简化关键帧（最多10个）', 'top');
        tooltips.register(uploadImages, '上传图片文件夹', 'top');
        tooltips.register(importCenter, '导入中心点 txt（3个实数）', 'top');
        tooltips.register(jumpNearest, '跳转到最近关键帧并对齐视角', 'top');
        tooltips.register(speed, localize('tooltip.timeline.frame-rate'), 'top');
        tooltips.register(frames, localize('tooltip.timeline.total-frames'), 'top');
        tooltips.register(smoothness, localize('tooltip.timeline.smoothness'), 'top');

        // 监听播放状态变化，同步UI
        events.on('timeline.playing', (isPlaying: boolean) => {
            play.text = isPlaying ? '\uE135' : '\uE131';
        });

    }
}

export { TimelinePanel };
