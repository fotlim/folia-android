// android/scripts/sync-web.mjs
// Copies a finished `vite build` into the APK's asset directory. Android has no symlink-friendly
// asset pipeline, so the shell owns its own copy and a stale copy is deleted first: an old chunk
// left behind would be served instead of the new build.

import { cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const source = path.join(projectRoot, 'dist');
const target = path.join(projectRoot, 'android/app/src/main/assets/public');

const assertDirectory = async (directory) => {
    try {
        const info = await stat(directory);
        return info.isDirectory();
    } catch {
        return false;
    }
};

const main = async () => {
    if (!(await assertDirectory(source))) {
        throw new Error(`No web build found at ${source}. Run "npm run build:android" instead of this script directly.`);
    }

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });

    const entries = await readdir(target);

    // Directories report their own (tiny) size, so the total comes from a recursive walk.
    const measure = async (directory) => {
        const children = await readdir(directory, { withFileTypes: true });
        const sizes = await Promise.all(children.map(async (child) => {
            const childPath = path.join(directory, child.name);
            if (child.isDirectory()) return measure(childPath);
            try {
                return (await stat(childPath)).size;
            } catch {
                return 0;
            }
        }));
        return sizes.reduce((total, value) => total + value, 0);
    };
    const size = await measure(target);

    console.log(`[android] Copied ${entries.length} top-level entries (${(size / 1024 / 1024).toFixed(1)} MiB) into ${path.relative(projectRoot, target)}`);
};

await main();
