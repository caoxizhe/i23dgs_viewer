import { Vec3 } from 'playcanvas';

import { Events } from './events';

type RemoteDisplacementMessage = {
    type: string;
    dx: number;
    dy: number;
    dz: number;
    vx?: number;
    vy?: number;
    vz?: number;
    speed?: number;
    origin?: number;
    ts?: number;
};

const toFixed = (v: number, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '0.000');

const registerRemoteControlEvents = (events: Events) => {
    let socket: WebSocket = null;
    let connected = false;

    const savedIp = localStorage.getItem('remote.ip') ?? '';
    const savedPort = localStorage.getItem('remote.port') ?? '8766';
    const savedScale = Number(localStorage.getItem('remote.scale') ?? '1');

    let scale = Number.isFinite(savedScale) ? savedScale : 1;

    let lastSample: {
        ready: boolean;
        origin: number;
        dx: number;
        dy: number;
        dz: number;
    } = {
        ready: false,
        origin: -1,
        dx: 0,
        dy: 0,
        dz: 0
    };

    // panel integrated with right toolbar (hidden by default)
    const panel = document.createElement('div');
    panel.id = 'right-toolbar-remote-panel';
    panel.className = 'right-toolbar-remote-panel';
    panel.style.position = 'absolute';
    panel.style.top = '0px';
    panel.style.right = '66px';
    panel.style.zIndex = '2';
    panel.style.display = 'none';
    panel.style.width = '300px';
    panel.style.padding = '12px';
    panel.style.borderRadius = '10px';
    panel.style.border = '1px solid rgba(255, 255, 255, 0.14)';
    panel.style.background = 'linear-gradient(180deg, rgba(31, 34, 40, 0.97), rgba(22, 24, 29, 0.97))';
    panel.style.boxShadow = '0 8px 26px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255,255,255,0.03)';
    panel.style.color = '#e1e4ea';
    panel.style.fontFamily = 'Inter, Segoe UI, system-ui, sans-serif';
    panel.style.fontSize = '12px';
    panel.style.pointerEvents = 'auto';

    const title = document.createElement('div');
    title.textContent = '远程控制';
    title.style.fontWeight = '700';
    title.style.letterSpacing = '0.6px';
    title.style.color = '#e5e8ee';
    title.style.marginBottom = '10px';

    const status = document.createElement('div');
    status.textContent = '状态: 未连接';
    status.style.marginBottom = '10px';
    status.style.padding = '6px 8px';
    status.style.borderRadius = '6px';
    status.style.background = 'rgba(37, 40, 47, 0.75)';
    status.style.border = '1px solid rgba(255, 255, 255, 0.12)';

    const inputLabelStyle = (el: HTMLElement) => {
        el.style.marginBottom = '4px';
        el.style.color = '#b7bcc6';
        el.style.fontSize = '11px';
    };

    const styleInput = (el: HTMLInputElement) => {
        el.style.width = '100%';
        el.style.height = '30px';
        el.style.padding = '0 10px';
        el.style.borderRadius = '6px';
        el.style.border = '1px solid rgba(255, 255, 255, 0.14)';
        el.style.background = 'rgba(18, 21, 27, 0.96)';
        el.style.color = '#eaedf2';
        el.style.outline = 'none';
        el.style.boxSizing = 'border-box';
    };

    const styleBtn = (el: HTMLButtonElement, primary: boolean) => {
        el.style.height = '32px';
        el.style.borderRadius = '6px';
        el.style.cursor = 'pointer';
        el.style.border = primary ? '1px solid rgba(255, 255, 255, 0.24)' : '1px solid rgba(255, 255, 255, 0.14)';
        el.style.background = primary
            ? 'linear-gradient(180deg, rgba(74, 79, 89, 0.98), rgba(52, 56, 64, 0.98))'
            : 'linear-gradient(180deg, rgba(46, 50, 58, 0.98), rgba(31, 34, 41, 0.98))';
        el.style.color = '#edf0f4';
        el.style.fontWeight = '600';
    };

    const ipLabel = document.createElement('div');
    ipLabel.textContent = '手机 IP';
    inputLabelStyle(ipLabel);

    const ipInput = document.createElement('input');
    ipInput.type = 'text';
    ipInput.placeholder = '手机 IP (例如 192.168.1.10)';
    ipInput.value = savedIp;
    styleInput(ipInput);
    ipInput.style.marginBottom = '8px';

    const portLabel = document.createElement('div');
    portLabel.textContent = '端口';
    inputLabelStyle(portLabel);

    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.value = savedPort;
    styleInput(portInput);
    portInput.style.marginBottom = '8px';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';
    btnRow.style.marginBottom = '8px';

    const connectBtn = document.createElement('button');
    connectBtn.textContent = '连接';
    connectBtn.style.flex = '1';
    styleBtn(connectBtn, true);

    const disconnectBtn = document.createElement('button');
    disconnectBtn.textContent = '断开';
    disconnectBtn.style.flex = '1';
    styleBtn(disconnectBtn, false);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '重置位移';
    resetBtn.style.width = '100%';
    styleBtn(resetBtn, false);
    resetBtn.style.marginBottom = '8px';

    const deltaLabel = document.createElement('div');
    deltaLabel.textContent = 'Δ: (0.000, 0.000, 0.000)';
    deltaLabel.style.color = '#b8bec8';
    deltaLabel.style.marginBottom = '4px';

    const totalLabel = document.createElement('div');
    totalLabel.textContent = '累计: (0.000, 0.000, 0.000)';
    totalLabel.style.color = '#c6ccd6';

    btnRow.append(connectBtn, disconnectBtn);
    panel.append(title, status, ipLabel, ipInput, portLabel, portInput, btnRow, resetBtn, deltaLabel, totalLabel);

    const mountPanel = () => {
        const rightToolbar = document.getElementById('right-toolbar');
        if (rightToolbar && panel.parentElement !== rightToolbar) {
            rightToolbar.appendChild(panel);
            panel.style.position = 'absolute';
            panel.style.top = '0px';
            panel.style.right = '66px';
            panel.style.zIndex = '2';
        } else if (!rightToolbar && !panel.parentElement) {
            document.body.appendChild(panel);
            panel.style.position = 'fixed';
            panel.style.top = '14px';
            panel.style.right = '14px';
            panel.style.zIndex = '60';
        }
    };

    mountPanel();

    const setStatus = (text: string) => {
        status.textContent = `状态: ${text}`;
    };

    const setScale = (value: number) => {
        const v = Number(value);
        if (!Number.isFinite(v) || v <= 0) return;
        scale = v;
        localStorage.setItem('remote.scale', `${scale}`);
        events.fire('remote.scale', scale);
    };

    let panelVisible = localStorage.getItem('remote.panel.visible') === '1';
    const setPanelVisible = (visible: boolean) => {
        mountPanel();
        panelVisible = !!visible;
        panel.style.display = panelVisible ? 'block' : 'none';
        localStorage.setItem('remote.panel.visible', panelVisible ? '1' : '0');
        events.fire('remotePanel.visible', panelVisible);
    };

    const closeSocket = () => {
        if (socket) {
            socket.onopen = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            socket.close();
            socket = null;
        }
        connected = false;
    };

    const resetLocalSample = () => {
        lastSample = {
            ready: false,
            origin: -1,
            dx: 0,
            dy: 0,
            dz: 0
        };
        deltaLabel.textContent = 'Δ: (0.000, 0.000, 0.000)';
        totalLabel.textContent = '累计: (0.000, 0.000, 0.000)';
    };

    const onDisplacement = (msg: RemoteDisplacementMessage) => {
        const origin = Number.isFinite(msg.origin) ? msg.origin : 0;

        if (!lastSample.ready || origin !== lastSample.origin) {
            lastSample.ready = true;
            lastSample.origin = origin;
            lastSample.dx = msg.dx;
            lastSample.dy = msg.dy;
            lastSample.dz = msg.dz;
            totalLabel.textContent = `累计: (${toFixed(msg.dx)}, ${toFixed(msg.dy)}, ${toFixed(msg.dz)})`;
            return;
        }

        const ddx = msg.dx - lastSample.dx;
        const ddy = msg.dy - lastSample.dy;
        const ddz = msg.dz - lastSample.dz;

        lastSample.dx = msg.dx;
        lastSample.dy = msg.dy;
        lastSample.dz = msg.dz;

        // reject unrealistic jump caused by sensor glitch / reconnection
        const jump = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (!Number.isFinite(jump) || jump > 1.0) {
            return;
        }

        const worldDelta = new Vec3(ddx * scale, ddy * scale, ddz * scale);
        events.fire('camera.remoteTranslate', {
            dx: worldDelta.x,
            dy: worldDelta.y,
            dz: worldDelta.z,
            raw: msg
        });

        deltaLabel.textContent = `Δ: (${toFixed(worldDelta.x)}, ${toFixed(worldDelta.y)}, ${toFixed(worldDelta.z)})`;
        totalLabel.textContent = `累计: (${toFixed(msg.dx)}, ${toFixed(msg.dy)}, ${toFixed(msg.dz)})`;
    };

    const connect = () => {
        if (socket) return;

        const ip = ipInput.value.trim();
        const port = portInput.value.trim() || '8766';

        if (!ip) {
            setStatus('请先输入手机 IP');
            return;
        }

        localStorage.setItem('remote.ip', ip);
        localStorage.setItem('remote.port', port);

        const url = `ws://${ip}:${port}`;
        setStatus(`连接中 ${url}`);

        try {
            socket = new WebSocket(url);
        } catch (err) {
            socket = null;
            setStatus(`连接失败: ${err}`);
            return;
        }

        socket.onopen = () => {
            connected = true;
            setStatus('已连接');
        };

        socket.onclose = () => {
            closeSocket();
            setStatus('已断开');
        };

        socket.onerror = () => {
            setStatus('连接错误');
        };

        socket.onmessage = (event: MessageEvent<string>) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg?.type === 'relative_displacement') {
                    onDisplacement(msg as RemoteDisplacementMessage);
                }
            } catch {
                // ignore malformed payload
            }
        };
    };

    const disconnect = () => {
        closeSocket();
        setStatus('已断开');
    };

    connectBtn.onclick = () => connect();
    disconnectBtn.onclick = () => disconnect();

    resetBtn.onclick = () => {
        resetLocalSample();
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'reset' }));
        }
    };

    events.function('remote.connected', () => connected);
    events.function('remote.scale', () => scale);
    events.function('remotePanel.visible', () => panelVisible);
    events.on('remote.setScale', (value: number) => setScale(value));
    events.on('remotePanel.setVisible', (value: boolean) => setPanelVisible(value));
    events.on('remotePanel.toggleVisible', () => setPanelVisible(!panelVisible));
    events.on('remote.connect', connect);
    events.on('remote.disconnect', disconnect);

    // initialize listeners that bind later (e.g. view panel)
    events.fire('remote.scale', scale);
    setPanelVisible(panelVisible);
};

export { registerRemoteControlEvents };
