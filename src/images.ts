import { Events } from './events';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

const isImageFile = (name: string) => {
    const lower = name.toLowerCase();
    return IMAGE_EXTS.some(ext => lower.endsWith(ext));
};

// Extract trailing number from filename for sorting (e.g., img_0012.png -> 12)
const extractIndex = (name: string): number => {
    if (!name) return Number.MAX_SAFE_INTEGER;
    const m = String(name).match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

const registerImageEvents = (events: Events) => {
    // Map frame -> HTMLImageElement[]
    const frameImageMap = new Map<number, HTMLImageElement[]>();
    // Map frame -> expected image base name (from cameras)
    const frameImageNameMap = new Map<number, string>();

    // Loaded images caches for matching
    type LoadedImg = { name: string; bare: string; index: number; img: HTMLImageElement };
    const loadedImages: LoadedImg[] = [];
    const byName = new Map<string, HTMLImageElement>();
    const byBare = new Map<string, HTMLImageElement>();
    const byIndex = new Map<number, HTMLImageElement>();

    // Allow setting frame name mapping from external sources (e.g., camera loading)
    events.on('images.setFrameName', (frame: number, name: string) => {
        frameImageNameMap.set(frame, name);
    });

    // Clear all images
    const clearImages = () => {
        frameImageMap.clear();
        frameImageNameMap.clear();
        loadedImages.length = 0;
        byName.clear();
        byBare.clear();
        byIndex.clear();
        events.fire('images.updated');
    };

    // Get images for a specific frame (or nearest previous keyframe)
    const getImagesForFrame = (frame: number): HTMLImageElement[] => {
        if (frameImageMap.size === 0) return [];

        // Find the greatest frame key <= current frame
        const sortedKeys = Array.from(frameImageMap.keys()).sort((a, b) => a - b);
        let displayFrame: number | null = null;

        for (const key of sortedKeys) {
            if (key <= frame) displayFrame = key;
            else break;
        }

        // Fallback to first frame if before all keyframes
        if (displayFrame === null && sortedKeys.length > 0) {
            displayFrame = sortedKeys[0];
        }

        return displayFrame !== null ? (frameImageMap.get(displayFrame) || []) : [];
    };

    const matchFrames = () => {
        // rebuild frameImageMap based on frameImageNameMap and loaded caches
        frameImageMap.clear();
        const frames = Array.from(frameImageNameMap.keys()).sort((a, b) => a - b);
        frames.forEach((frame) => {
            const target = frameImageNameMap.get(frame);
            if (!target) return;

            const bareTarget = String(target).replace(/\.[^/.]+$/, '');
            let img = byName.get(String(target)) ||
                byBare.get(bareTarget);
            if (!img) {
                const idx = extractIndex(String(target));
                if (Number.isFinite(idx) && byIndex.has(idx)) {
                    img = byIndex.get(idx)!;
                }
            }

            if (img) {
                frameImageMap.set(frame, [img]);
            }
        });

        events.fire('images.updated');
    };

    events.function('images.clear', () => clearImages());
    events.function('images.getForFrame', (frame: number) => getImagesForFrame(frame));
    events.function('images.hasImages', () => frameImageMap.size > 0);
    events.function('images.getFrameKeys', () => Array.from(frameImageMap.keys()));
    events.function('images.getFrameName', (frame: number) => frameImageNameMap.get(frame));
    events.on('images.setFrameName', (frame: number, name: string) => {
        frameImageNameMap.set(frame, name);
    });
    events.on('images.matchFrames', () => matchFrames());

    // Auto-load images by URL base using frame -> name mapping set by cameras
    events.on('images.autoLoadFromBase', (baseDir: string) => {
        if (!baseDir) return;
        if (frameImageNameMap.size === 0) {
            console.warn('[images.autoLoadFromBase] no frameImageNameMap entries');
            return;
        }
        const base = String(baseDir).replace(/\/$/, '');
        // Global URL dedupe across multiple triggers
        (window as any).__GS_IMAGE_URL_REQUESTED__ = (window as any).__GS_IMAGE_URL_REQUESTED__ || new Set<string>();
        const requested: Set<string> = (window as any).__GS_IMAGE_URL_REQUESTED__;

        let scheduled = 0;
        const frames = Array.from(frameImageNameMap.entries()).sort((a, b) => a[0] - b[0]);
        frames.forEach(([frame, name]) => {
            const raw = String(name);
            const candidates = [raw, `${raw}.png`, `${raw}.jpg`, `${raw}.jpeg`, `${raw}.webp`];
            // Pick first candidate (server decides existence)
            const url = `${base}/${candidates[0]}`;
            if (requested.has(url)) return;
            requested.add(url);

            const img = new Image();
            img.onload = () => {
                const arr = frameImageMap.get(frame) || [];
                // avoid duplicate same src
                if (!arr.some(i => i.src === img.src)) arr.push(img);
                frameImageMap.set(frame, arr);
                events.fire('images.updated');
            };
            img.onerror = () => { /* ignore missing */ };
            img.src = url;
            scheduled++;
        });

        if (scheduled > 0) {
            console.log(`[images.autoLoadFromBase] scheduled ${scheduled} image loads from ${base}`);
        }
        // trigger refresh in case some loads are immediate (cached)
        events.fire('images.updated');
    });

    // Upload images from a folder and match to timeline frames
    events.on('images.uploadFolder', () => {
        const dirInput = document.createElement('input');
        dirInput.type = 'file';
        (dirInput as any).webkitdirectory = true;
        dirInput.multiple = true;
        dirInput.accept = 'image/*';
        dirInput.style.display = 'none';

        dirInput.onchange = (ev: Event) => {
            const inputEl = ev.target as HTMLInputElement;
            const files = inputEl.files;
            if (!files || files.length === 0) {
                document.body.removeChild(dirInput);
                return;
            }

            // Clear existing image caches (keep frame names)
            loadedImages.length = 0;
            byName.clear();
            byBare.clear();
            byIndex.clear();

            // Build map of file names
            const fileMap = new Map<string, File>();
            const fileList: File[] = [];
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                if (isImageFile(f.name)) {
                    fileList.push(f);
                    fileMap.set(f.name, f);
                    const bare = f.name.replace(/\.[^/.]+$/, '');
                    if (!fileMap.has(bare)) fileMap.set(bare, f);
                }
            }

            // Sort files by extracted index
            fileList.sort((a, b) => {
                const idxA = extractIndex(a.name);
                const idxB = extractIndex(b.name);
                if (idxA !== idxB) return idxA - idxB;
                return a.name.localeCompare(b.name);
            });

            // Create image elements and cache by name / bare / index
            let loadedCount = 0;
            const totalFiles = fileList.length;

            fileList.forEach((file, index) => {
                const img = new Image();

                img.onload = () => {
                    const bare = file.name.replace(/\.[^/.]+$/, '');
                    const idx = extractIndex(file.name);
                    loadedImages.push({ name: file.name, bare, index: idx, img });
                    byName.set(file.name, img);
                    byBare.set(bare, img);
                    if (Number.isFinite(idx)) byIndex.set(idx, img);

                    loadedCount++;
                    if (loadedCount === totalFiles) {
                        // after loading all, try to match frames based on names provided by cameras
                        matchFrames();
                        console.log(`Loaded ${totalFiles} images from folder`);
                    }
                };

                img.onerror = () => {
                    loadedCount++;
                    if (loadedCount === totalFiles) {
                        matchFrames();
                    }
                };

                img.src = URL.createObjectURL(file);
            });

            document.body.removeChild(dirInput);
        };

        document.body.appendChild(dirInput);
        dirInput.click();
    });
};

export { registerImageEvents };
