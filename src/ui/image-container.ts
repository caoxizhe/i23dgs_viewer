import { Container } from '@playcanvas/pcui';

import { Events } from '../events';

class ImageContainer extends Container {
    private overlayEl: HTMLDivElement | null = null;
    private overlayScale = 1;
    
    // Image viewer state
    private viewerEl: HTMLDivElement | null = null;
    private viewerStageEl: HTMLDivElement | null = null;
    private viewerImgEl: HTMLImageElement | null = null;
    private viewerToolbarEl: HTMLDivElement | null = null;
    private viewerCloseBtn: HTMLButtonElement | null = null;
    private viewerPrevBtn: HTMLButtonElement | null = null;
    private viewerNextBtn: HTMLButtonElement | null = null;
    private viewerZoomInBtn: HTMLButtonElement | null = null;
    private viewerZoomOutBtn: HTMLButtonElement | null = null;
    private viewerFitBtn: HTMLButtonElement | null = null;
    private viewerOneBtn: HTMLButtonElement | null = null;

    private viewerImages: string[] = [];
    private viewerIndex = 0;
    private vScale = 1;
    private vMinScale = 0.1;
    private vMaxScale = 8;
    private vTx = 0;
    private vTy = 0;
    private vDragging = false;
    private vStartX = 0;
    private vStartY = 0;
    private vBaseX = 0;
    private vBaseY = 0;

    constructor(events: Events, args: any = {}) {
        args = {
            ...args,
            id: 'image-container'
        };
        super(args);

        // Hide the PCUI container itself
        this.dom.style.display = 'none';

        const showImagesForFrame = (frame: number) => {
            // 找到要显示的帧（持有上一个关键帧）并取得该帧图片
            const imgs = events.invoke('images.getForFrame', frame) as HTMLImageElement[];
            if (!imgs || imgs.length === 0) {
                // 无可显示图片：若已有容器则保留并不清空，避免闪烁；否则不创建
                if (!this.overlayEl) return;
                return;
            }

            // Find the display frame (greatest frame key <= current frame)
            const frameKeys = events.invoke('images.getFrameKeys') as number[];
            let displayFrame = frame;
            if (frameKeys && frameKeys.length > 0) {
                const sortedKeys = [...frameKeys].sort((a, b) => a - b);
                displayFrame = sortedKeys[0];
                for (const k of sortedKeys) {
                    if (k <= frame) displayFrame = k;
                    else break;
                }
            }

            const overlay = this.ensureOverlay(events);
            // 清空容器并重新填充
            while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

            // gather caption fields from camera-poses
            const idText = events.invoke('camera.frameCameraId', displayFrame) ?? '';
            const rawPos = events.invoke('camera.frameRawPos', displayFrame) as [number, number, number] | undefined;
            const rawRot = events.invoke('camera.frameRawRot', displayFrame) as number[] | null | undefined;
            const fmt3 = (a: number[]) => `[${a[0].toFixed(3)}, ${a[1].toFixed(3)}, ${a[2].toFixed(3)}]`;
            const rotText = rawRot && rawRot.length === 9
                ? `[[${rawRot[0].toFixed(3)}, ${rawRot[1].toFixed(3)}, ${rawRot[2].toFixed(3)}],\n [${rawRot[3].toFixed(3)}, ${rawRot[4].toFixed(3)}, ${rawRot[5].toFixed(3)}],\n [${rawRot[6].toFixed(3)}, ${rawRot[7].toFixed(3)}, ${rawRot[8].toFixed(3)}]]`
                : 'N/A';

            // layout images as thumbnails in top-right corner
            const padding = 8;
            const thumbW = 240;
            const thumbH = Math.round(thumbW * 0.75);
            const captionH = 100;
            imgs.forEach((img, i) => {
                const wrapper = document.createElement('div');
                wrapper.style.position = 'absolute';
                wrapper.style.top = `${padding + i * (thumbH + padding)}px`;
                // 右上角展示
                wrapper.style.right = `${padding}px`;
                wrapper.style.width = `${thumbW}px`;
                wrapper.style.height = `${thumbH + captionH}px`;
                wrapper.style.pointerEvents = 'auto';
                wrapper.style.background = 'rgba(0,0,0,0.95)';
                wrapper.style.padding = '4px';
                wrapper.style.boxSizing = 'border-box';
                wrapper.style.borderRadius = '4px';
                wrapper.style.cursor = 'zoom-in';

                const clone = img.cloneNode(true) as HTMLImageElement;
                clone.style.width = '100%';
                clone.style.height = `${thumbH}px`;
                clone.style.objectFit = 'cover';
                clone.style.pointerEvents = 'auto';

                wrapper.appendChild(clone);

                // caption text for camera info
                const cap = document.createElement('div');
                cap.style.width = '100%';
                cap.style.height = `${captionH}px`;
                cap.style.color = '#fff';
                cap.style.fontSize = '12px';
                cap.style.textAlign = 'center';
                cap.style.pointerEvents = 'none';
                cap.style.whiteSpace = 'pre-line';
                cap.style.background = 'rgba(0,0,0,0.95)';
                cap.style.borderRadius = '3px';
                cap.style.padding = '4px 6px';
                cap.style.overflow = 'hidden';
                cap.style.wordBreak = 'break-word';

                // Combine camera_id, img_name and raw position/rotation for display
                const imgName = events.invoke('images.getFrameName', displayFrame) ?? 'unknown';
                const posText = rawPos ? fmt3(rawPos as any) : 'N/A';
                // 仅在有原始旋转数据时输出 rotation 行，避免残留的 "rotation: N/A"
                const lines: string[] = [
                    `camera id: ${idText}`,
                    `img name: ${imgName}`,
                    `position: ${posText}`
                ];
                if (rawRot && rawRot.length === 9) {
                    lines.push(`rotation: ${rotText}`);
                }
                cap.textContent = lines.join('\n');

                wrapper.appendChild(cap);

                // dblclick 打开图片查看器，从当前图片开始
                wrapper.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    const allImgs = imgs.map(im => im.src);
                    this.openImageViewer(allImgs, i);
                });
                overlay.appendChild(wrapper);
            });
        };

        // Listen to timeline frame changes
        events.on('timeline.frame', (frame: number) => {
            showImagesForFrame(frame);
        });

        // Listen to timeline time changes (during playback)
        events.on('timeline.time', (frame: number) => {
            showImagesForFrame(Math.floor(frame));
        });

        // Listen to images updated
        events.on('images.updated', () => {
            const frame = events.invoke('timeline.frame') as number || 0;
            showImagesForFrame(frame);
        });
    }

    private ensureOverlay(events: Events): HTMLDivElement {
        if (this.overlayEl && document.body.contains(this.overlayEl)) return this.overlayEl;
        const el = document.createElement('div');
        el.id = 'camera-image-overlay';
        el.style.position = 'fixed';
        el.style.top = '0';
        el.style.right = '0';
        el.style.width = 'auto';
        el.style.height = 'auto';
        el.style.zIndex = '1000';
        el.style.userSelect = 'none';
        el.style.touchAction = 'none';
        el.style.pointerEvents = 'auto';
        // 默认无平移
        el.style.transform = 'translate(0px, 0px) scale(1)';
        el.style.transformOrigin = 'top right';

        const setTransform = (tx: number, ty: number) => {
            el.style.transform = `translate(${tx}px, ${ty}px) scale(${this.overlayScale})`;
        };

        // 仅绑定一次拖拽
        if (!(el as any).dataset?.draggableApplied) {
            // 标记已绑定，注意不能整体替换 dataset（只读），应逐项赋值
            (el as any).dataset.draggableApplied = '1';
            let dragActive = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragBaseX = 0;
            let dragBaseY = 0;
            const onPointerDown = (ev: PointerEvent) => {
                if (!ev.isPrimary || ev.button !== 0) return;
                dragActive = true;
                dragStartX = ev.clientX;
                dragStartY = ev.clientY;
                const m = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
                dragBaseX = m ? parseFloat(m[1]) : 0;
                dragBaseY = m ? parseFloat(m[2]) : 0;
                try { (el as any).setPointerCapture?.(ev.pointerId); } catch { /* noop */ }
            };
            const onPointerMove = (ev: PointerEvent) => {
                if (!dragActive) return;
                const dx = ev.clientX - dragStartX;
                const dy = ev.clientY - dragStartY;
                const x = dragBaseX + dx;
                const y = dragBaseY + dy;
                setTransform(x, y);
            };
            const onPointerUp = (ev: PointerEvent) => {
                if (!dragActive) return;
                dragActive = false;
                try { (el as any).releasePointerCapture?.(ev.pointerId); } catch { /* noop */ }
            };
            el.addEventListener('pointerdown', onPointerDown);
            el.addEventListener('pointermove', onPointerMove);
            el.addEventListener('pointerup', onPointerUp);

            // dblclick on container: open image viewer with current images
            el.addEventListener('dblclick', (ev) => {
                ev.stopPropagation();
                const imgs = Array.from(el.querySelectorAll('img')) as HTMLImageElement[];
                const urls = imgs.map(i => i.src).filter(Boolean);
                if (urls.length > 0) this.openImageViewer(urls, 0);
            });
        }

        document.body.appendChild(el);
        this.overlayEl = el;
        return this.overlayEl;
    }

    private destroyOverlay() {
        if (this.overlayEl && this.overlayEl.parentElement) {
            this.overlayEl.parentElement.removeChild(this.overlayEl);
        }
        this.overlayEl = null;
    }

    private ensureImageViewer(): HTMLDivElement | null {
        if (this.viewerEl && document.body.contains(this.viewerEl)) return this.viewerEl;
        const root = document.createElement('div');
        root.id = 'image-viewer-overlay';
        root.style.position = 'fixed';
        root.style.left = '0';
        root.style.top = '0';
        root.style.width = '100%';
        root.style.height = '100%';
        root.style.background = 'rgba(0,0,0,0.85)';
        root.style.zIndex = '3000';
        root.style.display = 'none';
        root.style.userSelect = 'none';
        root.style.touchAction = 'none';

        // close button (top-right)
        const closeBtn = document.createElement('button');
        closeBtn.title = '关闭';
        closeBtn.textContent = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '10px';
        closeBtn.style.right = '12px';
        closeBtn.style.width = '36px';
        closeBtn.style.height = '36px';
        closeBtn.style.border = 'none';
        closeBtn.style.borderRadius = '18px';
        closeBtn.style.background = 'rgba(0,0,0,0.6)';
        closeBtn.style.color = '#fff';
        closeBtn.style.fontSize = '24px';
        closeBtn.style.lineHeight = '36px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.zIndex = '1';
        root.appendChild(closeBtn);

        // stage area
        const stage = document.createElement('div');
        stage.style.position = 'absolute';
        stage.style.left = '0';
        stage.style.top = '0';
        stage.style.right = '0';
        stage.style.bottom = '0';
        stage.style.overflow = 'hidden';
        stage.style.cursor = 'grab';
        root.appendChild(stage);

        const img = document.createElement('img');
        img.style.position = 'absolute';
        img.style.left = '0';
        img.style.top = '0';
        img.style.willChange = 'transform';
        img.style.transformOrigin = '0 0';
        stage.appendChild(img);

        // toolbar
        const toolbar = document.createElement('div');
        toolbar.style.position = 'absolute';
        toolbar.style.left = '50%';
        toolbar.style.transform = 'translateX(-50%)';
        toolbar.style.bottom = '16px';
        toolbar.style.background = 'rgba(0,0,0,0.5)';
        toolbar.style.padding = '6px 10px';
        toolbar.style.borderRadius = '6px';
        toolbar.style.display = 'flex';
        toolbar.style.gap = '8px';

        const mkBtn = (label: string, title: string) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            b.style.color = '#fff';
            b.style.background = 'rgba(255,255,255,0.1)';
            b.style.border = '1px solid rgba(255,255,255,0.2)';
            b.style.borderRadius = '4px';
            b.style.padding = '4px 8px';
            b.style.cursor = 'pointer';
            return b;
        };
        const btnZoomOut = mkBtn('−', '缩小');
        const btnZoomIn = mkBtn('+', '放大');
        const btnOne = mkBtn('1:1', '实际像素');
        const btnFit = mkBtn('适配', '适配窗口');
        const btnPrev = mkBtn('◀', '上一张');
        const btnNext = mkBtn('▶', '下一张');
        toolbar.append(btnZoomOut, btnZoomIn, btnOne, btnFit, btnPrev, btnNext);
        root.appendChild(toolbar);

        document.body.appendChild(root);

        // wire refs
        this.viewerEl = root;
        this.viewerStageEl = stage;
        this.viewerImgEl = img;
        this.viewerToolbarEl = toolbar;
        this.viewerCloseBtn = closeBtn;
        this.viewerZoomInBtn = btnZoomIn;
        this.viewerZoomOutBtn = btnZoomOut;
        this.viewerFitBtn = btnFit;
        this.viewerOneBtn = btnOne;
        this.viewerPrevBtn = btnPrev;
        this.viewerNextBtn = btnNext;

        // interactions
        const applyTransform = () => {
            if (!this.viewerImgEl) return;
            this.viewerImgEl.style.transform = `translate(${this.vTx}px, ${this.vTy}px) scale(${this.vScale})`;
        };
        const computeFit = () => {
            if (!this.viewerStageEl || !this.viewerImgEl) return 1;
            const sw = this.viewerStageEl.clientWidth;
            const sh = this.viewerStageEl.clientHeight;
            const iw = (this.viewerImgEl.naturalWidth || this.viewerImgEl.width) || 1;
            const ih = (this.viewerImgEl.naturalHeight || this.viewerImgEl.height) || 1;
            const s = Math.min(sw / iw, sh / ih) * 0.98;
            return Math.max(0.05, Math.min(8, s));
        };
        const centerImage = () => {
            if (!this.viewerStageEl || !this.viewerImgEl) return;
            const sw = this.viewerStageEl.clientWidth;
            const sh = this.viewerStageEl.clientHeight;
            const iw = (this.viewerImgEl.naturalWidth || this.viewerImgEl.width) || 1;
            const ih = (this.viewerImgEl.naturalHeight || this.viewerImgEl.height) || 1;
            this.vTx = Math.round((sw - iw * this.vScale) / 2);
            this.vTy = Math.round((sh - ih * this.vScale) / 2);
            applyTransform();
        };
        const setScale = (s: number) => {
            this.vScale = Math.max(this.vMinScale, Math.min(this.vMaxScale, s));
            applyTransform();
        };
        const wheelZoom = (e: WheelEvent) => {
            if (!this.viewerStageEl || !this.viewerImgEl) return;
            e.preventDefault();
            const rect = this.viewerStageEl.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const prev = this.vScale;
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            const next = Math.max(this.vMinScale, Math.min(this.vMaxScale, this.vScale * factor));
            if (next === prev) return;
            // pivot at cursor
            const mx = (cx - this.vTx) / prev;
            const my = (cy - this.vTy) / prev;
            this.vTx = cx - mx * next;
            this.vTy = cy - my * next;
            this.vScale = next;
            applyTransform();
        };
        const setImage = (index: number) => {
            if (!this.viewerImgEl) return;
            this.viewerIndex = Math.max(0, Math.min(this.viewerImages.length - 1, index));
            const url = this.viewerImages[this.viewerIndex];
            this.viewerImgEl.src = url;
            this.viewerImgEl.onload = () => {
                this.vMinScale = computeFit();
                setScale(this.vMinScale);
                centerImage();
            };
        };

        // pointer pan
        stage.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return;
            this.vDragging = true;
            this.vStartX = ev.clientX;
            this.vStartY = ev.clientY;
            this.vBaseX = this.vTx;
            this.vBaseY = this.vTy;
            stage.setPointerCapture?.(ev.pointerId);
            stage.style.cursor = 'grabbing';
        });
        stage.addEventListener('pointermove', (ev) => {
            if (!this.vDragging) return;
            this.vTx = this.vBaseX + (ev.clientX - this.vStartX);
            this.vTy = this.vBaseY + (ev.clientY - this.vStartY);
            applyTransform();
        });
        stage.addEventListener('pointerup', (ev) => {
            if (!this.vDragging) return;
            this.vDragging = false;
            stage.releasePointerCapture?.(ev.pointerId);
            stage.style.cursor = 'grab';
        });
        stage.addEventListener('wheel', wheelZoom, { passive: false });
        stage.addEventListener('dblclick', (ev) => {
            // toggle 1:1 / fit
            this.vScale = Math.abs(this.vScale - 1) < 1e-3 ? this.vMinScale : 1;
            centerImage();
            ev.stopPropagation();
        });

        // toolbar actions
        btnZoomIn.addEventListener('click', () => { setScale(this.vScale * 1.2); });
        btnZoomOut.addEventListener('click', () => { setScale(this.vScale / 1.2); });
        btnOne.addEventListener('click', () => { setScale(1); centerImage(); });
        btnFit.addEventListener('click', () => {
            this.vMinScale = computeFit();
            setScale(this.vMinScale);
            centerImage();
        });
        btnPrev.addEventListener('click', () => {
            if (this.viewerImages.length) setImage((this.viewerIndex - 1 + this.viewerImages.length) % this.viewerImages.length);
        });
        btnNext.addEventListener('click', () => {
            if (this.viewerImages.length) setImage((this.viewerIndex + 1) % this.viewerImages.length);
        });
        closeBtn.addEventListener('click', () => { this.closeImageViewer(); });

        // expose helpers on root for reuse
        (root as any)._setImage = setImage;
        (root as any)._centerImage = centerImage;
        (root as any)._computeFit = computeFit;

        return this.viewerEl;
    }

    private openImageViewer(urls: string[], startIndex = 0) {
        this.ensureImageViewer();
        if (!this.viewerEl) return;
        this.viewerImages = urls.slice();
        this.viewerIndex = Math.max(0, Math.min(urls.length - 1, startIndex));
        this.viewerEl.style.display = 'block';
        // load image
        (this.viewerEl as any)._setImage(this.viewerIndex);
        // close on Esc
        const onKey = (e: KeyboardEvent) => {
            if (!this.viewerEl || this.viewerEl.style.display === 'none') return;
            if (e.key === 'Escape') { this.closeImageViewer(); }
            if (e.key === 'ArrowLeft') { this.viewerPrevBtn?.click(); }
            if (e.key === 'ArrowRight') { this.viewerNextBtn?.click(); }
            if (e.key === '+') { this.viewerZoomInBtn?.click(); }
            if (e.key === '-') { this.viewerZoomOutBtn?.click(); }
        };
        window.addEventListener('keydown', onKey);
        (this.viewerEl as any)._onKey = onKey;
    }

    private closeImageViewer() {
        if (!this.viewerEl) return;
        this.viewerEl.style.display = 'none';
        if ((this.viewerEl as any)._onKey) window.removeEventListener('keydown', (this.viewerEl as any)._onKey);
    }
}

export { ImageContainer };
