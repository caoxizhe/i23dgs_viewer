import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { BufferWriter } from './serialize/writer';
import { Splat } from './splat';
import { serializePly } from './splat-serialize';
import { State } from './splat-state';

const registerGlobalSortEvents = (scene: Scene, events: Events) => {
    let rebuilding = false;
    let pending = false;
    let suppress = false;
    let sceneClearing = false;
    let generation = 0;

    let proxySplat: Splat = null;
    let proxyRanges = new Map<Splat, { start: number, count: number }>();

    const getAllSplats = () => {
        return scene.getElementsByType(ElementType.splat) as Splat[];
    };

    const getSourceSplats = () => {
        return getAllSplats().filter(splat => splat !== proxySplat);
    };

    const clearProxy = () => {
        if (!proxySplat) {
            return;
        }

        const oldProxy = proxySplat;
        proxySplat = null;
        proxyRanges = new Map();

        if (oldProxy.scene) {
            suppress = true;
            try {
                oldProxy.destroy();
            } finally {
                suppress = false;
            }
        }
    };

    const restoreSourceVisibility = () => {
        suppress = true;
        try {
            getSourceSplats().forEach((splat) => {
                splat.renderSuppressed = false;
            });
        } finally {
            suppress = false;
        }
    };

    const hideSourceSplats = () => {
        suppress = true;
        try {
            getSourceSplats().forEach((splat) => {
                splat.renderSuppressed = true;
            });
        } finally {
            suppress = false;
        }
    };

    const getMergeSplats = () => {
        return getSourceSplats()
        .filter(splat => !splat.isGlobalSortProxy)
        .filter(splat => splat.numSplats > 0);
    };

    const buildProxyRanges = (splats: Splat[]) => {
        const ranges = new Map<Splat, { start: number, count: number }>();
        let cursor = 0;

        splats.forEach((splat) => {
            const state = splat.splatData.getProp('state') as Uint8Array;
            let count = 0;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.deleted) === 0) {
                    count++;
                }
            }

            ranges.set(splat, { start: cursor, count });
            cursor += count;
        });

        return ranges;
    };

    const applyVisibilityMaskToProxy = () => {
        if (!proxySplat || !proxySplat.scene) {
            return;
        }

        const state = proxySplat.splatData.getProp('state') as Uint8Array;
        if (!state) {
            return;
        }

        proxyRanges.forEach((range, sourceSplat) => {
            const hidden = !sourceSplat.visible;
            const end = range.start + range.count;
            for (let i = range.start; i < end; ++i) {
                if (hidden) {
                    state[i] |= State.deleted;
                } else {
                    state[i] &= ~State.deleted;
                }
            }
        });

        // upload state without forcing expensive remapping sort path
        proxySplat.updateState(State.selected);
    };

    const disposeDetachedSplat = (splat: Splat) => {
        if (!splat) return;
        if (splat.scene) {
            splat.destroy();
            return;
        }

        // avoid calling destroy() on detached splats: engine component teardown can
        // read entity.scene.layers and fail while scene is undefined.
        try {
            splat.asset.registry.remove(splat.asset);
        } catch {
            // ignore cleanup errors
        }

        try {
            splat.asset.unload();
        } catch {
            // ignore cleanup errors
        }
    };

    const rebuildProxy = async () => {
        if (sceneClearing) {
            return;
        }

        if (rebuilding) {
            pending = true;
            return;
        }

        rebuilding = true;
        const rebuildGeneration = generation;

        events.fire('startSpinner');

        try {
            clearProxy();

            if (sceneClearing || rebuildGeneration !== generation) {
                return;
            }

            const mergeSplats = getMergeSplats();
            if (mergeSplats.length === 0) {
                restoreSourceVisibility();
                return;
            }

            const nextRanges = buildProxyRanges(mergeSplats);

            const writer = new BufferWriter();
            await serializePly(mergeSplats, {
                maxSHBands: events.invoke('view.bands') ?? 3
            }, writer);

            const buffers = writer.close();
            if (!buffers || buffers.length === 0) {
                restoreSourceVisibility();
                return;
            }

            const blob = new Blob(buffers as unknown as ArrayBuffer[], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            try {
                const merged = await scene.assetLoader.load({
                    url,
                    filename: '__global_sort__.ply',
                    animationFrame: true
                });

                if (sceneClearing || rebuildGeneration !== generation) {
                    disposeDetachedSplat(merged);
                    return;
                }

                suppress = true;
                try {
                    scene.add(merged);
                } finally {
                    suppress = false;
                }

                if (sceneClearing || rebuildGeneration !== generation) {
                    disposeDetachedSplat(merged);
                    return;
                }

                merged.isGlobalSortProxy = true;
                merged.name = '[Global Sort]';

                proxySplat = merged;
                proxyRanges = nextRanges;
                hideSourceSplats();
                applyVisibilityMaskToProxy();
            } finally {
                URL.revokeObjectURL(url);
            }
        } catch (error) {
            console.error(error);
            restoreSourceVisibility();
            await events.invoke('showPopup', {
                type: 'error',
                header: 'GLOBAL SORT',
                message: `Failed to rebuild global sorting proxy: '${error?.message ?? error}'`
            });
        } finally {
            events.fire('stopSpinner');
            rebuilding = false;

            if (pending) {
                pending = false;
                await rebuildProxy();
            }

            scene.forceRender = true;
        }
    };

    const requestRebuild = () => {
        if (suppress || sceneClearing) {
            return;
        }
        rebuildProxy().catch((error) => {
            console.error(error);
        });
    };

    events.function('globalSort.enabled', () => {
        return true;
    });

    events.on('globalSort.setEnabled', async (value: boolean) => {
        if (value) {
            await rebuildProxy();
        }
        events.fire('globalSort.enabled', true);
    });

    events.on('globalSort.toggle', async () => {
        await rebuildProxy();
        events.fire('globalSort.enabled', true);
    });

    events.on('globalSort.rebuild', () => {
        requestRebuild();
    });

    events.on('scene.clearing', () => {
        sceneClearing = true;
        generation++;
        pending = false;

        clearProxy();
        restoreSourceVisibility();
    });

    events.on('scene.elementAdded', (element: any) => {
        if (element.type === ElementType.splat) {
            sceneClearing = false;
            requestRebuild();
        }
    });

    events.on('scene.elementRemoved', (element: any) => {
        if (element.type === ElementType.splat) {
            requestRebuild();
        }
    });

    events.on('splat.visibility', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        if (proxySplat) {
            applyVisibilityMaskToProxy();
            return;
        }
        requestRebuild();
    });

    events.on('splat.stateChanged', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.positionsChanged', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.moved', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.tintClr', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.temperature', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.saturation', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.brightness', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.blackPoint', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.whitePoint', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('splat.transparency', (splat: Splat) => {
        if (splat?.isGlobalSortProxy) {
            return;
        }
        requestRebuild();
    });

    events.on('view.bands', () => {
        requestRebuild();
    });

    // always-on behavior
    events.fire('globalSort.enabled', true);
};

export { registerGlobalSortEvents };
