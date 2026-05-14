import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let ffmpeg = null;

/**
 * Concatenate multiple video URLs into a single video Blob.
 * Uses ffmpeg.wasm running entirely in the browser.
 * @param {string[]} urls - Array of video URLs to concatenate
 * @param {function} onProgress - Optional progress callback (0-100)
 * @returns {Promise<Blob>} - The concatenated video as a Blob
 */
export async function concatVideos(urls, onProgress) {
    if (!urls || urls.length === 0) throw new Error('No video URLs provided');
    if (urls.length === 1) {
        // Single video — just fetch and return as blob
        const resp = await fetch(urls[0]);
        return await resp.blob();
    }

    // Initialize ffmpeg if not already loaded
    if (!ffmpeg) {
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => {
            console.log('[ffmpeg]', message);
        });
        if (onProgress) onProgress(5);
        // Load single-threaded core (no COOP/COEP headers needed)
        await ffmpeg.load({
            coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
            wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
        });
        if (onProgress) onProgress(15);
    }

    // Download all videos and write to ffmpeg virtual filesystem
    const fileNames = [];
    for (let i = 0; i < urls.length; i++) {
        const name = `scene_${i}.mp4`;
        fileNames.push(name);
        if (onProgress) onProgress(15 + Math.round((i / urls.length) * 30));
        console.log(`[concat] Downloading scene ${i + 1}/${urls.length}...`);
        const data = await fetchFile(urls[i]);
        await ffmpeg.writeFile(name, data);
    }

    if (onProgress) onProgress(50);

    // Re-encode each to ensure consistent format (some Fal.ai videos may use different codecs)
    const reEncodedNames = [];
    for (let i = 0; i < fileNames.length; i++) {
        const outName = `re_${i}.ts`;
        reEncodedNames.push(outName);
        if (onProgress) onProgress(50 + Math.round((i / fileNames.length) * 30));
        console.log(`[concat] Re-encoding scene ${i + 1}/${fileNames.length}...`);
        await ffmpeg.exec([
            '-i', fileNames[i],
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-bsf:v', 'h264_mp4toannexb',
            '-f', 'mpegts',
            '-y', outName
        ]);
    }

    if (onProgress) onProgress(80);

    // Concatenate using concat protocol
    const concatInput = reEncodedNames.map(n => `concat:${n}`).join('|');
    // Use concat demuxer approach instead  
    const concatList = reEncodedNames.map(n => `file '${n}'`).join('\n');
    await ffmpeg.writeFile('list.txt', concatList);

    console.log('[concat] Merging all scenes...');
    await ffmpeg.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', 'list.txt',
        '-c', 'copy',
        '-y', 'output.mp4'
    ]);

    if (onProgress) onProgress(95);

    // Read the output file
    const outputData = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });

    // Cleanup
    for (const name of [...fileNames, ...reEncodedNames, 'list.txt', 'output.mp4']) {
        try { await ffmpeg.deleteFile(name); } catch (e) { /* ignore */ }
    }

    if (onProgress) onProgress(100);
    return blob;
}
