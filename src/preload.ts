import { Events } from './events';

// 优化的预加载：
// 1. 直接 import sog 与 cameras
// 2. cameras 导入完成后，若 window.__GS_PRELOAD__ 含 camerasUrl，再主动 fetch 其 JSON 内容并触发 camera.autoLoadCameras
// 3. 若存在 imagesUrl（或新的 __GS_IMAGES_BASE__），在关键帧建立后由 camera.autoLoadCameras 内部触发 images.autoLoadFromBase
export async function runPreload(events: Events) {
    const preload: any = (window as any).__GS_PRELOAD__;
    if (!preload) {
        console.debug('[preload] no __GS_PRELOAD__ found; skip auto import');
        return;
    }
    const { sogUrl, plyUrl, preferPly, camerasUrl } = preload;
    const primaryUrl = (preferPly && plyUrl) ? plyUrl : (sogUrl || plyUrl);

    // Step1: 导入主模型（优先ply，fallback sog）与 cameras（使用原有 import 机制，让场景与资源注册正常）
    if (primaryUrl) {
        try {
            const fname = (() => {
                try {
                    return new URL(primaryUrl, document.baseURI).pathname.split('/').pop();
                } catch {
                    return primaryUrl;
                }
            })();
            await events.invoke('import', [{ filename: fname, url: primaryUrl }]);
        } catch (e) {
            console.warn('[preload] primary import failed', e);
        }
    }
    let camerasJson: any[] | null = null;
    if (camerasUrl) {
    // 可选：尝试通过 import 让资源做缓存（JSON 分支在 v2 需要 contents，可能失败，失败也不影响后续 fetch）
        try {
            const fname = (() => {
                try {
                    return new URL(camerasUrl, document.baseURI).pathname.split('/').pop();
                } catch {
                    return camerasUrl;
                }
            })();
            await events.invoke('import', [{ filename: fname, url: camerasUrl }]);
        } catch (e) {
            console.warn('[preload] cameras optional import failed (expected for JSON without contents)', e);
        }
        // 主路径：直接 fetch JSON 并触发 camera.autoLoadCameras
        try {
            const r = await fetch(camerasUrl);
            if (r.ok) {
                const js = await r.json();
                if (Array.isArray(js)) camerasJson = js;
                else if (js?.poses && Array.isArray(js.poses)) camerasJson = js.poses; // 兼容旧格式
            } else {
                console.warn('[preload] cameras fetch failed status=', r.status);
            }
        } catch (e) {
            console.warn('[preload] cameras fetch error', e);
        }
    }
    // Step2: 若成功获取 cameras 数据，触发自动关键帧构建事件
    if (camerasJson && camerasJson.length) {
        events.fire('camera.autoLoadCameras', camerasJson);
    }
    // Step3: 图片目录基路径：优先 __GS_IMAGES_BASE__，否则 preload.imagesUrl 兼容旧字段
    const imagesBase: string | undefined = (window as any).__GS_IMAGES_BASE__ || preload.imagesUrl;
    if (imagesBase) {
    // 图片加载放在 camera.autoLoadCameras 内部延迟执行（需先建立 frameImageNameMap）
    // 若 camerasJson 不存在（没有关键帧），仍可尝试直接触发，内部会检查映射是否有数据
        events.fire('images.autoLoadFromBase', imagesBase);
    }
    console.log('[preload done]');
}
