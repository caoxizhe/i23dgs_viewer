import { EventHandle } from 'playcanvas';

import { Events } from './events';
import { Splat } from './splat';
import { ElementType } from './element';

const registerTimelineEvents = (events: Events) => {
    // frames
    // let frames = 180;
    let frames = 1200; 
    let smoothness = 1;

    const setFrames = (value: number) => {
        if (value !== frames) {
            frames = value;
            events.fire('timeline.frames', frames);
        }
    };

    events.function('timeline.frames', () => {
        return frames;
    });

    events.on('timeline.setFrames', (value: number) => {
        setFrames(value);
    });

    // frame rate
    let frameRate = 30;

    const setFrameRate = (value: number) => {
        if (value !== frameRate) {
            frameRate = value;
            events.fire('timeline.frameRate', frameRate);
        }
    };

    events.function('timeline.frameRate', () => {
        return frameRate;
    });

    events.on('timeline.setFrameRate', (value: number) => {
        setFrameRate(value);
    });

    // smoothness

    const setSmoothness = (value: number) => {
        if (value !== smoothness) {
            smoothness = value;
            events.fire('timeline.smoothness', smoothness);
        }
    };

    events.function('timeline.smoothness', () => {
        return smoothness;
    });

    events.on('timeline.setSmoothness', (value: number) => {
        setSmoothness(value);
    });

    // current frame
    let frame = 0;

    const setFrame = (value: number) => {
        if (value !== frame) {
            frame = value;
            events.fire('timeline.frame', frame);
        }
    };

    events.function('timeline.frame', () => {
        return frame;
    });

    events.on('timeline.setFrame', (value: number) => {
        setFrame(value);
    });

    // anim controls
    let animHandle: EventHandle = null;

    const play = () => {
        let time = frame;

        // handle application update tick
        animHandle = events.on('update', (dt: number) => {
            time = (time + dt * frameRate) % frames;
            setFrame(Math.floor(time));
            events.fire('timeline.time', time);
        });
    };

    const stop = () => {
        animHandle.off();
        animHandle = null;
    };

    // playing state
    let playing = false;

    const setPlaying = (value: boolean) => {
        if (value !== playing) {
            playing = value;
            events.fire('timeline.playing', playing);
            if (playing) {
                play();
            } else {
                stop();
            }
        }
    };

    events.function('timeline.playing', () => {
        return playing;
    });

    events.on('timeline.setPlaying', (value: boolean) => {
        setPlaying(value);
    });

    // 添加播放/暂停切换事件
    events.on('timeline.togglePlaying', () => {
        setPlaying(!playing);
    });

    // keys per splat - 每个splat都有自己的关键帧数组
    const splatKeys = new Map<Splat, number[]>();

    // 获取当前选中splat的关键帧
    const getCurrentSplatKeys = (): number[] => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return [];
        }
        
        if (!splatKeys.has(selectedSplat)) {
            splatKeys.set(selectedSplat, []);
        }
        
        return splatKeys.get(selectedSplat)!;
    };

    events.function('timeline.keys', () => {
        return getCurrentSplatKeys();
    });

    // 为当前选中的splat添加关键帧
    events.on('timeline.addKey', (frame: number) => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return;
        }
        
        if (!splatKeys.has(selectedSplat)) {
            splatKeys.set(selectedSplat, []);
        }
        
        const keys = splatKeys.get(selectedSplat)!;
        if (!keys.includes(frame)) {
            keys.push(frame);
            events.fire('timeline.keyAdded', frame);
        }
    });

    // 从当前选中的splat删除关键帧
    events.on('timeline.removeKey', (index: number) => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return;
        }
        
        const keys = splatKeys.get(selectedSplat);
        if (keys && index >= 0 && index < keys.length) {
            keys.splice(index, 1);
            events.fire('timeline.keyRemoved', index);
        }
    });

    // 设置当前选中splat的关键帧
    events.on('timeline.setKey', (index: number, frame: number) => {
        const selectedSplat = events.invoke('selection') as Splat;
        if (!selectedSplat) {
            return;
        }
        
        const keys = splatKeys.get(selectedSplat);
        if (keys && index >= 0 && index < keys.length && frame !== keys[index]) {
            keys[index] = frame;
            events.fire('timeline.keySet', index, frame);
        }
    });

    // 当选择变化时，更新UI显示当前splat的关键帧
    events.on('selection.changed', (selection: Splat) => {
        // 触发重建timeline以显示新选中splat的关键帧
        events.fire('timeline.selectionChanged', selection);
    });

    // 当splat被移除时，清理其关键帧数据
    events.on('scene.elementRemoved', (element: any) => {
        if (element.type === ElementType.splat) {
            splatKeys.delete(element as Splat);
        }
    });

    // 获取指定splat的关键帧（用于序列化等）
    events.function('timeline.getSplatKeys', (splat: Splat) => {
        return splatKeys.get(splat) || [];
    });

    // 设置指定splat的关键帧（用于反序列化等）
    events.on('timeline.setSplatKeys', (splat: Splat, keys: number[]) => {
        splatKeys.set(splat, keys.slice());
    });

    // 跳转到第一个关键帧
    events.function('timeline.jumpToFirstKey', () => {
        const keys = getCurrentSplatKeys();
        if (keys.length > 0) {
            // 对关键帧排序，找到第一个
            const sortedKeys = keys.slice().sort((a, b) => a - b);
            const firstKey = sortedKeys[0];
            
            // 跳转到第一个关键帧
            setFrame(firstKey);
            console.log(`跳转到第一个关键帧: ${firstKey}`);
            return true;
        } else {
            console.log('当前PLY没有关键帧');
            return false;
        }
    });

    // doc

    events.function('docSerialize.timeline', () => {
        // 序列化所有splat的关键帧数据
        const splatKeysData: { [name: string]: number[] } = {};
        splatKeys.forEach((keys, splat) => {
            if (keys.length > 0) {
                splatKeysData[splat.name] = keys.slice();
            }
        });

        return {
            frames,
            frameRate,
            frame,
            splatKeys: splatKeysData,
            smoothness
        };
    });

    events.function('docDeserialize.timeline', (data: any = {}) => {
        events.fire('timeline.setFrames', data.frames ?? 180);
        events.fire('timeline.setFrameRate', data.frameRate ?? 30);
        events.fire('timeline.setFrame', data.frame ?? 0);
        events.fire('timeline.setSmoothness', data.smoothness ?? 1);

        // 恢复splat关键帧数据
        if (data.splatKeys) {
            // 延迟恢复，等待所有splat加载完成
            setTimeout(() => {
                const allSplats = events.invoke('scene.allSplats') as Splat[];
                Object.entries(data.splatKeys).forEach(([splatName, keys]) => {
                    const splat = allSplats.find(s => s.name === splatName);
                    if (splat && Array.isArray(keys)) {
                        splatKeys.set(splat, keys.slice());
                    }
                });
                
                // 触发UI更新
                const currentSelection = events.invoke('selection') as Splat;
                if (currentSelection) {
                    events.fire('timeline.selectionChanged', currentSelection);
                }
            }, 100);
        }
    });
};

export { registerTimelineEvents };
