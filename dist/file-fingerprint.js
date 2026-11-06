async function fingerprint(file) {
    if (!globalThis.crypto?.subtle) return file.name + '|' + file.size + '|' + file.lastModified;
    const chunkSize = 4194304;
    const digests = new Uint8Array(Math.ceil(file.size / chunkSize) * 32);
    for (let offset = 0; offset < file.size; offset += chunkSize) {
        const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', chunk);
        digests.set(new Uint8Array(digest), offset / chunkSize * 32);
    }
    const digest = await crypto.subtle.digest('SHA-256', digests);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,'0')).join('');
}
