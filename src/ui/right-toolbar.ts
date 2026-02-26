import { Button, Container, Element, Label } from '@playcanvas/pcui';
import { Element as SceneElement, ElementType } from '../element';
import { Events } from '../events';
import { localize } from './localization';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import centersSvg from './svg/centers.svg';
import colorPanelSvg from './svg/color-panel.svg';
import ringsSvg from './svg/rings.svg';
import showHideSplatsSvg from './svg/show-hide-splats.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const ringsModeToggle = new Button({
            id: 'right-toolbar-mode-toggle',
            class: 'right-toolbar-toggle'
        });

        const showHideSplats = new Button({
            id: 'right-toolbar-show-hide',
            class: ['right-toolbar-toggle', 'active']
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        const colorPanel = new Button({
            id: 'right-toolbar-color-panel',
            class: 'right-toolbar-toggle'
        });

        const remoteControl = new Button({
            id: 'right-toolbar-remote-control',
            class: ['right-toolbar-toggle', 'right-toolbar-text-toggle'],
            text: 'RC'
        });

        const options = new Button({
            id: 'right-toolbar-options',
            class: 'right-toolbar-toggle',
            icon: 'E283'
        });

        const centersDom = createSvg(centersSvg);
        const ringsDom = createSvg(ringsSvg);
        ringsDom.style.display = 'none';

        ringsModeToggle.dom.appendChild(centersDom);
        ringsModeToggle.dom.appendChild(ringsDom);
        showHideSplats.dom.appendChild(createSvg(showHideSplatsSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));
        colorPanel.dom.appendChild(createSvg(colorPanelSvg));

        this.append(ringsModeToggle);
        this.append(showHideSplats);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraReset);
        this.append(colorPanel);
        this.append(remoteControl);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(options);

        tooltips.register(ringsModeToggle, localize('tooltip.right-toolbar.splat-mode'), 'left');
        tooltips.register(showHideSplats, localize('tooltip.right-toolbar.show-hide'), 'left');
        tooltips.register(cameraFrameSelection, localize('tooltip.right-toolbar.frame-selection'), 'left');
        tooltips.register(cameraReset, localize('tooltip.right-toolbar.reset-camera'), 'left');
        tooltips.register(colorPanel, localize('tooltip.right-toolbar.colors'), 'left');
        tooltips.register(remoteControl, localize('tooltip.right-toolbar.remote-control'), 'left');
        tooltips.register(options, localize('tooltip.right-toolbar.view-options'), 'left');

        // add event handlers

        ringsModeToggle.on('click', () => {
            events.fire('camera.toggleMode');
            events.fire('camera.setOverlay', true);
        });
        showHideSplats.on('click', () => events.fire('camera.toggleOverlay'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
        colorPanel.on('click', () => events.fire('colorPanel.toggleVisible'));
        remoteControl.on('click', () => events.fire('remotePanel.toggleVisible'));
        options.on('click', () => events.fire('viewPanel.toggleVisible'));

        events.on('camera.mode', (mode: string) => {
            ringsModeToggle.class[mode === 'rings' ? 'add' : 'remove']('active');
            centersDom.style.display = mode === 'rings' ? 'none' : 'block';
            ringsDom.style.display = mode === 'rings' ? 'block' : 'none';
        });

        events.on('camera.overlay', (value: boolean) => {
            showHideSplats.class[value ? 'add' : 'remove']('active');
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            colorPanel.class[visible ? 'add' : 'remove']('active');
        });

        events.on('remotePanel.visible', (visible: boolean) => {
            remoteControl.class[visible ? 'add' : 'remove']('active');
        });

        events.on('viewPanel.visible', (visible: boolean) => {
            options.class[visible ? 'add' : 'remove']('active');
        });

        // 当场景中首次出现 splat 时，自动关闭 Overlay 激活态
        const turnOffOverlayIfNeeded = () => {
            events.fire('camera.setOverlay', false);
        };
        try {
            const splats = events.invoke('scene.splats') as any[];
            if (Array.isArray(splats) && splats.length > 0) {
                turnOffOverlayIfNeeded();
            }
        } catch { /* noop */ }
        events.on('scene.elementAdded', (element: SceneElement) => {
            if (element?.type === ElementType.splat) {
                turnOffOverlayIfNeeded();
            }
        });
    }
}

export { RightToolbar };
