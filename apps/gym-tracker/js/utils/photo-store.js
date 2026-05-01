/**
 * Photo store — upload and read progress photos backed by Firebase
 * Storage at `users/{uid}/gym-tracker/measurements/{measurementId}/{n}.jpg`.
 *
 * Strategy:
 *   - Client-side compression: long-edge 1024 px, JPEG quality 0.85.
 *     Uses an OffscreenCanvas when available, falls back to a hidden
 *     <canvas>. A typical phone photo (~3 MB) lands at ~120-180 KB.
 *   - Storage path mirrors Firestore so security rules can be one
 *     "users/{uid} can read+write under their own UID" path matcher
 *     (already deployed).
 *   - The Measurement model carries `photos: string[]` — an array of
 *     download URLs in upload order. Round-trips through sync without
 *     special handling because Firestore stores it as a JSON array.
 *
 * Lazy-loads the Firebase Storage SDK only when actually used so users
 * who never log a photo don't pay the bytes.
 */

let _storageMod = null;
async function getStorage() {
    if (_storageMod) return _storageMod;
    const [{ getStorage: gs, ref, uploadBytes, getDownloadURL, deleteObject },
           { app: firebaseApp }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js'),
        import('../../../../firebase-config.js'),
    ]);
    _storageMod = { storage: gs(firebaseApp), ref, uploadBytes, getDownloadURL, deleteObject };
    return _storageMod;
}

/**
 * Compress a File / Blob to a JPEG with the long edge clamped to
 * `maxEdge`. Returns a Blob.
 */
export async function compressImage(file, { maxEdge = 1024, quality = 0.85 } = {}) {
    if (!file) throw new Error('No file');
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));

    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(w, h);
    } else {
        canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    if (canvas.convertToBlob) {
        return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    return await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality);
    });
}

/**
 * Upload one image for the given measurement. Returns the public
 * download URL that can be stuffed into Measurement.photos.
 *
 * Requires the user to be signed in — throws otherwise.
 */
export async function uploadMeasurementPhoto(measurementId, file, userId) {
    if (!userId) throw new Error('Not signed in');
    const compressed = await compressImage(file);
    const { storage, ref, uploadBytes, getDownloadURL } = await getStorage();
    const path = `users/${userId}/gym-tracker/measurements/${measurementId}/${Date.now()}.jpg`;
    const r = ref(storage, path);
    await uploadBytes(r, compressed, { contentType: 'image/jpeg' });
    return await getDownloadURL(r);
}

/**
 * Best-effort delete by URL. Errors are logged but not rethrown — a
 * photo orphaned in Storage is a tiny cost not worth blocking the UI.
 */
export async function deleteMeasurementPhoto(url) {
    try {
        const { storage, ref, deleteObject } = await getStorage();
        // Storage SDK can resolve a download URL to a ref via parsing,
        // but the simplest path is constructing a ref from the URL
        // directly via `ref(storage, url)` — supported since v9.
        const r = ref(storage, url);
        await deleteObject(r);
    } catch (err) {
        console.warn('Failed to delete photo', err);
    }
}
